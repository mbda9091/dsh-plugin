import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDsh } from '../core/dsh-cli.js'
import { fetchPage } from '../core/exec.js'
import { ensurePnpmShim, initProfile, runDsh, childEnv, serveAndCheck, resolvePnpmScript, freshHome } from '../core/web-harness.js'
import type { WebHarness } from '../core/web-harness.js'
import { runToFiles } from '../core/exec.js'
export { resolvePnpmScript } from '../core/web-harness.js'
import { isRecord, readJson, stringArray, writeText } from '../core/json.js'
import { repoRoot } from '../core/repo.js'

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
  readonly timeoutMs: number
}

interface StepRecord {
  name: string
  ok: boolean
  durationMs: number
  detail?: string
}

interface Row {
  name: string
  disabled: boolean
}

const WEB_PROFILE = 'web'

export async function runL4(options: L4Options): Promise<number> {
  const runner = resolveDsh()
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const runBase = join(repoRoot, '.tmp', 'l4')
  mkdirSync(runBase, { recursive: true })
  const runDir = mkdtempSync(join(runBase, `${runId}-`))
  const logDir = join(runDir, 'logs')
  const artifactDir = join(runDir, 'artifacts')
  const home = freshHome(runDir, options.home)
  const reportPath = join(repoRoot, '.tmp', 'l4', 'last-report.json')
  const steps: StepRecord[] = []

  console.log(`l4: dsh  -> ${runner.source}`)
  console.log(`l4: home -> ${home}`)
  console.log(`l4: run  -> ${runDir}`)

  const context: L4Context = { runner, home, runDir, logDir, artifactDir, options }

  const step = async (name: string, body: () => Promise<string | undefined>): Promise<void> => {
    const started = Date.now()
    try {
      const detail = await body()
      steps.push({ name, ok: true, durationMs: Date.now() - started, detail })
      console.log(`l4: ok   ${name} (${Date.now() - started}ms)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      steps.push({ name, ok: false, durationMs: Date.now() - started, detail: message })
      console.error(`l4: FAIL ${name} (${Date.now() - started}ms)\n${message}`)
      throw error
    }
  }

  let passed = true
  try {
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
  } catch {
    passed = false
  }

  const report = {
    ok: passed,
    dsh: runner.source,
    home,
    runDir,
    logDir,
    steps,
  }
  writeText(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`l4: report -> ${reportPath}`)
  for (const entry of steps) {
    console.log(`l4: ${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} (${entry.durationMs}ms)`)
  }

  if (passed && !options.keep && (options.home === undefined || options.home === '')) {
    rmSync(runDir, { recursive: true, force: true })
    console.log('l4: temporary run directory removed (--keep to retain successful runs)')
  } else {
    console.log(`l4: ${passed ? 'logs' : 'failure logs and report'} kept under ${runDir}`)
  }

  if (!passed) {
    console.error('l4: FAILED; see the report and logs above')
    return 1
  }
  console.log('l4: all checks passed')
  return 0
}

interface L4Context extends WebHarness {
  readonly artifactDir: string
  readonly options: L4Options
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
    runDsh(
      context,
      `install-link-${lastSegment(target)}`,
      ['plugin', '--profile', WEB_PROFILE, 'add', target],
      context.home,
      240_000,
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

  const rows = parseRows(dumpConfig(context, 'dump-link', context.home))
  assertRow(rows, 'web-hello', '@local/web-hello')
  assertRow(rows, 'approval-allowlist', '@local/approval-allowlist')
  assertRow(rows, 'notify-web', '@local/notify-web')
  return 'link install + rows enabled'
}

async function installMismatch(context: L4Context): Promise<string> {
  runDsh(
    context,
    'install-mismatch',
    ['plugin', '--profile', WEB_PROFILE, 'add', join(repoRoot, 'test', 'fixtures', 'target-mismatch')],
    context.home,
    240_000,
  )
  const rows = parseRows(dumpConfig(context, 'dump-mismatch', context.home))
  assertRow(rows, 'target-mismatch', '@local/target-mismatch')
  return 'mismatched fixture installed; failure asserted at runtime'
}

async function installTarball(context: L4Context): Promise<string> {
  const home = join(context.runDir, 'dsh-home-tarball')
  context.tarballHome = home
  await initProfile(context, 'profile-init-tarball', home)

  const pnpm = resolvePnpmScript()
  const packDir = join(context.artifactDir, 'tarball')
  mkdirSync(packDir, { recursive: true })
  const pack = runToFiles(process.execPath, [pnpm, 'pack', '--pack-destination', packDir], {
    cwd: join(repoRoot, 'approval-allowlist'),
    env: childEnv(context, home),
    timeoutMs: 240_000,
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

  runDsh(context, 'install-tarball', ['plugin', '--profile', WEB_PROFILE, 'add', tarball], home, 240_000)

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

  assertRow(parseRows(dumpConfig(context, 'dump-tarball', home)), 'approval-allowlist', '@local/approval-allowlist')
  return `tarball install is a real copy (${lastSegment(tarball)})`
}

/** Start `dsh web`, run the assertions, then stop it and prove the port closed. */
function dumpConfig(context: L4Context, label: string, home: string): string {
  return runDsh(context, label, ['--profile', WEB_PROFILE, '--dump-config'], home).stdout
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
