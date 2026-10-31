import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuredPnpm, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { fetchPage } from '../core/exec.js'
import { ensurePnpmShim, initProfile, runDsh, childEnv, serveAndCheck } from '../core/web-harness.js'
import type { WebHarness } from '../core/web-harness.js'
import { runToFilesAsync } from '../core/exec.js'
import { isRecord, readJson, stringArray } from '../core/json.js'
import { repoRoot } from '../core/repo.js'
import { runIsolatedTest } from '../core/test-run.js'
import type { TestReport } from '../core/test-run.js'
import type { ArtifactSet } from '../core/artifacts.js'
import { artifactPrerequisites, installArtifacts, checkArtifactInstallations, webArtifacts } from '../core/artifact-harness.js'

/**
 * L4: install into a disposable profile, then assert the loader's observable
 * state — no browser.
 *
 * The phases follow docs/testing-plan.md §4:
 *   1. a fresh workspace-local `DSH_HOME` assembles the shipped web profile;
 *   2. `link:` install puts a Web fixture and a real dual-target plugin in;
 *   3. `dsh web` serves HTTP 200 and its boot HTML contains the client module;
 *   4. a plugin whose declared target cannot match is reported as *failed*
 *      (`dsh: warning: N entry did not activate`), not silently ignored;
 *   5. the same plugin installed from a packed tarball is a real copy and still
 *      loads (`files`/`exports` are correct for the stable install mode).
 *
 * Everything the child prints goes to files (DSH's sandbox denies pipes), and
 * the server is a direct child so it can be stopped deterministically.
 */
export interface L4Options {
  readonly keep: boolean
  readonly home?: string | undefined
  readonly skipTarball: boolean
  readonly timeoutMs?: number
  readonly artifacts?: ArtifactSet
}

interface Row {
  name: string
  disabled: boolean
}

const WEB_PROFILE = 'web'

export async function runL4(input: L4Options, settings: CommandContext = loadCommandContext({}, undefined, undefined, 'test'), onReport?: (report: TestReport) => void): Promise<number> {
  const options = { ...input, timeoutMs: input.timeoutMs ?? settings.config.test.timeoutMs }
  return runIsolatedTest('l4', settings, options, async run => {
    const context: L4Context = { ...run, artifactDir: join(run.runDir, 'artifacts'), options }
    const step = run.step
    if (options.artifacts) {
      const artifacts = options.artifacts
      if (options.skipTarball) throw new Error('artifact mode cannot skip tarball checks')
      await step('package-contracts', async () => artifactPrerequisites(context, artifacts))
      await step('profile-init', () => initProfile(context, 'profile-init', context.home))
      await step('install-artifacts', async () => {
        const evidence = await installArtifacts(context, artifacts)
        const rows = parseRows(await dumpConfig(context, 'dump-artifacts', context.home))
        for (const item of webArtifacts(artifacts)) assertRow(rows, item.name.slice(7), item.name)
        return evidence
      })
      await step('web-artifacts', () => serveAndCheck(context, 'artifacts', async (url, stderr) => {
        const page = await fetchAuthorizedPage(url)
        if (/did not activate|@local\//.test(stderr)) throw new Error(`artifact activation failed: ${stderr}`)
        for (const item of webArtifacts(artifacts).filter(p => p.client)) if (!page.html.includes(item.name)) throw new Error(`missing client: ${item.name}`)
        if (artifacts.packages.has('@local/notify-web')) await checkSse(page.pageUrl, page.cookie)
        checkArtifactInstallations(context, artifacts)
        return `HTTP, client modules and applicable SSE passed; manifest ${artifacts.hash}`
      }))
      return
    }
    await step('prerequisites', () => checkPrerequisites(context))
    await step('profile-init', () => initProfile(context, 'profile-init', context.home))
    await step('install-link', () => installLinks(context))
    await step('web-link', () =>
      serveAndCheck(context, 'link', async (url, stderr) => {
        const page = await fetchAuthorizedPage(url)
        for (const module of ['@local/web-hello', '@local/notify-web']) {
          if (!page.html.includes(module)) throw new Error(`boot HTML is missing the ${module} client module`)
        }
        if (stderr.includes('did not activate')) throw new Error(`compatible plugins failed to activate:\n${stderr}`)
        if (/@local\//.test(stderr)) throw new Error(`unexpected @local warning in server stderr:\n${stderr}`)
        const sse = await checkSse(page.pageUrl, page.cookie)
        return `HTTP 200, boot HTML contains both client modules, no activation warnings, ${sse}`
      }),
    )
    await step('install-mismatch', () => installMismatch(context))
    await step('web-mismatch', () =>
      serveAndCheck(context, 'mismatch', async (url, stderr) => {
        if (!/entry did not activate/.test(stderr)) {
          throw new Error(`a target-mismatched plugin was not reported as failed; stderr:\n${stderr || '(empty)'}`)
        }
        if (!/target-mismatch/.test(stderr)) throw new Error(`failure does not name the plugin; stderr:\n${stderr}`)
        if (!/target mismatch/.test(stderr)) throw new Error(`failure does not explain the target mismatch; stderr:\n${stderr}`)
        const html = await fetchHtml(url)
        if (html === '') throw new Error('server did not serve the page')
        return 'failed row is reported by the loader and the server stays up'
      }),
    )
    if (!options.skipTarball) {
      await step('install-tarball', () => installTarball(context))
      await step('web-tarball', () =>
        serveAndCheck(
          context,
          'tarball',
          async (url, stderr) => {
            const html = await fetchHtml(url)
            if (html === '') throw new Error('server did not serve the page')
            if (stderr.includes('did not activate')) throw new Error(`tarball-installed plugin failed to activate:\n${stderr}`)
            return 'HTTP 200, tarball-installed plugin activates'
          },
          context.tarballHome,
        ),
      )
    }
  }, onReport)
}

interface L4Context extends WebHarness {
  readonly artifactDir: string
  readonly options: L4Options & { readonly timeoutMs: number }
  tarballHome?: string | undefined
}

async function checkPrerequisites(context: L4Context): Promise<string> {
  const required = [
    join(repoRoot, 'approval-allowlist', 'lib', 'index.js'),
    join(repoRoot, 'notify-web', 'lib', 'index.js'),
    join(repoRoot, 'notify-web', 'lib', 'client.js'),
    join(repoRoot, 'test', 'fixtures', 'web-hello', 'client.js'),
    join(repoRoot, 'test', 'fixtures', 'target-mismatch', 'index.js'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`missing ${path}; run node scripts/bootstrap.mjs build first`)
  }
  ensurePnpmShim(context)
  return 'built plugin and fixtures are present; pnpm shim ready'
}

/** Install through the manager, then check both manifest and composed rows. */
async function installLinks(context: L4Context): Promise<string> {
  const targets = [
    join(repoRoot, 'test', 'fixtures', 'web-hello'),
    join(repoRoot, 'approval-allowlist'),
    join(repoRoot, 'notify-web'),
  ]
  for (const target of targets) {
    await runDsh(
      context,
      `install-link-${lastSegment(target)}`,
      ['plugin', '--profile', WEB_PROFILE, 'add', target],
      context.home,
      context.options.timeoutMs,
    )
  }

  const profile = readProfile(context.home)
  const dependencies = isRecord(profile['dependencies']) ? profile['dependencies'] : {}
  const bundles = readBundles(profile)
  for (const name of ['@local/web-hello', '@local/approval-allowlist', '@local/notify-web']) {
    const spec = dependencies[name]
    if (typeof spec !== 'string' || !spec.toLowerCase().startsWith('link:')) {
      throw new Error(`${name} is not a link: dependency (got ${JSON.stringify(spec)})`)
    }
    if (!bundles.includes(name)) throw new Error(`${name} is missing from dsh.profile.bundles`)
  }

  const rows = parseRows(await dumpConfig(context, 'dump-link', context.home))
  assertRow(rows, 'web-hello', '@local/web-hello')
  assertRow(rows, 'approval-allowlist', '@local/approval-allowlist')
  assertRow(rows, 'notify-web', '@local/notify-web')
  return 'link install + rows enabled'
}

async function installMismatch(context: L4Context): Promise<string> {
  await runDsh(
    context,
    'install-mismatch',
    ['plugin', '--profile', WEB_PROFILE, 'add', join(repoRoot, 'test', 'fixtures', 'target-mismatch')],
    context.home,
    context.options.timeoutMs,
  )
  const rows = parseRows(await dumpConfig(context, 'dump-mismatch', context.home))
  assertRow(rows, 'target-mismatch', '@local/target-mismatch')
  return 'mismatched fixture installed; failure asserted at runtime'
}

async function installTarball(context: L4Context): Promise<string> {
  const home = join(context.runDir, 'dsh-home-tarball')
  context.tarballHome = home
  await initProfile(context, 'profile-init-tarball', home)

  const pnpm = configuredPnpm(context.settings)
  const packDir = join(context.artifactDir, 'tarball')
  mkdirSync(packDir, { recursive: true })
  const pack = await runToFilesAsync(process.execPath, [pnpm, 'pack', '--pack-destination', packDir], {
    cwd: join(repoRoot, 'approval-allowlist'),
    signal: context.signal,
    env: childEnv(context, home),
    timeoutMs: context.options.timeoutMs,
    stdoutPath: join(context.logDir, 'pack.out.log'),
    stderrPath: join(context.logDir, 'pack.err.log'),
  })
  if (pack.status !== 0) {
    throw new Error(`pnpm pack exited with ${pack.status}\nstdout:\n${pack.stdout.trim()}\nstderr:\n${pack.stderr.trim()}`)
  }

  const tarballs = readdirSync(packDir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(packDir, name))
  if (tarballs.length !== 1) throw new Error(`expected exactly one packed tarball in ${packDir}, found ${tarballs.length}`)
  const tarball = tarballs[0]
  if (tarball === undefined) throw new Error('packed tarball path is missing')

  await runDsh(context, 'install-tarball', ['plugin', '--profile', WEB_PROFILE, 'add', tarball], home, context.options.timeoutMs)

  const profile = readProfile(home)
  const dependencies = isRecord(profile['dependencies']) ? profile['dependencies'] : {}
  const spec = dependencies['@local/approval-allowlist']
  if (typeof spec !== 'string' || !/\.tgz$/i.test(spec)) {
    throw new Error(`@local/approval-allowlist is not installed from a tarball (got ${JSON.stringify(spec)})`)
  }
  if (!readBundles(profile).includes('@local/approval-allowlist')) {
    throw new Error('@local/approval-allowlist is missing from dsh.profile.bundles')
  }

  const installed = join(home, 'profiles', WEB_PROFILE, 'node_modules', '@local', 'approval-allowlist')
  if (!existsSync(installed)) throw new Error(`tarball install did not create ${installed}`)
  if (lstatSync(installed).isSymbolicLink()) {
    throw new Error(`${installed} is still a link; the stable install did not copy files`)
  }

  assertRow(parseRows(await dumpConfig(context, 'dump-tarball', home)), 'approval-allowlist', '@local/approval-allowlist')
  return `tarball install is a real copy (${lastSegment(tarball)})`
}

/** Start `dsh web`, run the assertions, then stop it and prove the port closed. */
async function dumpConfig(context: L4Context, label: string, home: string): Promise<string> {
  return (await runDsh(context, label, ['--profile', WEB_PROFILE, '--dump-config'], home)).stdout
}

function readProfile(home: string): Record<string, unknown> {
  const path = join(home, 'profiles', WEB_PROFILE, 'package.json')
  if (!existsSync(path)) throw new Error(`profile manifest not found: ${path}`)
  const manifest = readJson(path)
  if (!isRecord(manifest)) throw new Error(`profile manifest is not an object: ${path}`)
  return manifest
}

function readBundles(profile: Record<string, unknown>): string[] {
  const dsh = isRecord(profile['dsh']) ? profile['dsh'] : undefined
  const section = isRecord(dsh?.['profile']) ? dsh['profile'] : undefined
  return stringArray(section?.['bundles'])
}

/** Parse the flat loader rows printed by `--dump-config`. */
function parseRows(config: string): Map<string, Row> {
  const lines = config.split(/\r?\n/)
  const rows = new Map<string, Row>()
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*- id:\s*(\S+)\s*$/.exec(lines[index] ?? '')
    if (match === null) continue
    const id = match[1]
    if (id === undefined) continue

    let name = ''
    let disabled = false
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner] ?? ''
      if (/^\s*- id:/.test(line) || /^#/.test(line)) break
      const nameMatch = /^\s+name:\s*'([^']*)'/.exec(line)
      if (nameMatch !== null) name = nameMatch[1] ?? ''
      if (/^\s+disabled:\s*true\s*$/.test(line)) disabled = true
    }
    rows.set(id, { name, disabled })
  }
  return rows
}

function assertRow(rows: Map<string, Row>, id: string, name: string): void {
  const row = rows.get(id)
  if (row === undefined) throw new Error(`loader row '${id}' is missing from --dump-config`)
  if (row.name !== name) {
    throw new Error(`loader row '${id}' has name ${JSON.stringify(row.name)}, expected ${JSON.stringify(name)}`)
  }
  if (row.disabled) throw new Error(`loader row '${id}' is disabled`)
}

async function fetchHtml(url: string): Promise<string> {
  const { status, html } = await fetchPage(url)
  if (status !== 200) throw new Error(`GET ${url} returned ${status}, expected 200`)
  return html
}

/**
 * Exchange the one-time launch token for the browser auth cookie and return the
 * authenticated page plus the cookie needed by a follow-up API request.
 *
 * @param url - launch URL printed by `dsh web`.
 * @returns the page body, authorized page URL, and cookie header.
 */
async function fetchAuthorizedPage(url: string): Promise<{ html: string; pageUrl: string; cookie: string }> {
  const signal = AbortSignal.timeout(10_000)
  const first = await fetch(url, { redirect: 'manual', signal })
  if (first.status < 300 || first.status >= 400) {
    const html = await first.text()
    if (first.status !== 200) throw new Error(`GET ${url} returned ${first.status}, expected 200 or a redirect`)
    return { html, pageUrl: url, cookie: '' }
  }
  const location = first.headers.get('location')
  const getSetCookie = first.headers.getSetCookie
  const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(first.headers) : []
  const cookie = cookies.map((entry) => entry.split(';')[0] ?? '').filter((entry) => entry !== '').join('; ')
  await first.text()
  const pageUrl = location === null ? url : new URL(location, url).href
  const second = await fetch(pageUrl, { headers: cookie === '' ? undefined : { cookie }, signal })
  if (second.status !== 200) throw new Error(`GET ${pageUrl} returned ${second.status}, expected 200`)
  return { html: await second.text(), pageUrl, cookie }
}

/**
 * Prove the real Connection route accepts the browser cookie and immediately
 * emits the SSE `sync` frame. This is not a browser notification test; it is the
 * transport/authentication half that L4 can exercise without a browser.
 *
 * @param pageUrl - authenticated page URL (no launch token required).
 * @param cookie - cookie header from {@link fetchAuthorizedPage}.
 * @returns a short assertion detail.
 */
async function checkSse(pageUrl: string, cookie: string): Promise<string> {
  const endpoint = new URL('api/notify-web/events', pageUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const anonymous = await fetch(endpoint, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    })
    await anonymous.text()
    if (anonymous.status !== 401 && anonymous.status !== 403) {
      throw new Error(`unauthenticated GET ${endpoint.pathname} returned ${anonymous.status}, expected 401/403`)
    }
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        accept: 'text/event-stream',
        ...cookie === '' ? {} : { cookie },
      },
    })
    if (response.status !== 200) throw new Error(`GET ${endpoint.pathname} returned ${response.status}, expected 200`)
    if (!/\btext\/event-stream\b/.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`GET ${endpoint.pathname} returned ${JSON.stringify(response.headers.get('content-type'))}, expected text/event-stream`)
    }
    if (response.body === null) throw new Error('notify-web SSE route returned no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (let chunk = 0; chunk < 10 && !text.includes('event: sync'); chunk += 1) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      text += decoder.decode(value, { stream: true })
    }
    if (!text.includes('event: sync')) throw new Error(`notify-web SSE first frame is not sync: ${JSON.stringify(text.slice(0, 120))}`)
    await reader.cancel()
    return 'authenticated SSE route emitted sync'
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
