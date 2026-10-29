import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DshRunner } from './dsh-cli.js'
import { runToFiles, sleep, startToFiles, stopChild, tail, waitForHttp, waitForHttpClosed, waitForServerUrl } from './exec.js'
import type { RunResult } from './exec.js'
import { repoRoot } from './repo.js'

const WEB_PROFILE = 'web'

/** Never accept an existing home or a symlink escaping the workspace scratch area. */
export function freshHome(runDir: string, requested?: string): string {
  const home = resolve(requested || join(runDir, 'dsh-home'))
  const scratch = realpathSync(join(repoRoot, '.tmp'))
  let ancestor = dirname(home)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const actual = resolve(realpathSync(ancestor), relative(ancestor, home))
  const inside = relative(scratch, actual)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || existsSync(home)) {
    throw new Error('--home must be a new directory inside the workspace .tmp (existing profiles are never reused)')
  }
  return home
}

/** Shared disposable-profile lifecycle for L4 and L5. */
export interface WebHarness {
  readonly runner: DshRunner
  readonly home: string
  readonly runDir: string
  readonly logDir: string
  readonly options: { readonly timeoutMs: number }
  pnpmDir?: string | undefined
}
export function childEnv(context: WebHarness, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...context.runner.env,
    DSH_HOME: home,
    DSH_PROFILE: WEB_PROFILE,
    // pnpm 11 uses pnpm_config_*; older runtimes use npm_config_*.
    // Keep SQLite's index/WAL and package writes out of the user's global store.
    pnpm_config_store_dir: join(context.runDir, 'pnpm-store'),
    npm_config_store_dir: join(context.runDir, 'pnpm-store'),
  }
  delete env['DSH_PROFILE_DIR']
  delete env['DSH_WEB_URL']
  if (context.pnpmDir !== undefined) {
    env['PATH'] = env['PATH'] === undefined ? context.pnpmDir : `${context.pnpmDir}${delimiter}${env['PATH']}`
  }
  return env
}

export function runDsh(
  context: WebHarness,
  label: string,
  args: readonly string[],
  home: string,
  timeoutMs = context.options.timeoutMs,
): RunResult {
  const result = runToFiles(context.runner.command, context.runner.build(args), {
    cwd: repoRoot,
    env: childEnv(context, home),
    timeoutMs,
    verbatim: context.runner.verbatim,
    stdoutPath: join(context.logDir, `${label}.out.log`),
    stderrPath: join(context.logDir, `${label}.err.log`),
  })
  if (result.timedOut) throw new Error(`dsh ${args.join(' ')} timed out after ${timeoutMs}ms (${label})`)
  if (result.status !== 0) {
    throw new Error(
      `dsh ${args.join(' ')} exited with ${result.status} (${label})\n` +
        `stdout:\n${result.stdout.trim() || '(empty)'}\n` +
        `stderr:\n${result.stderr.trim() || '(empty)'}`,
    )
  }
  return result
}


/** Give the child CLI a pinned pnpm without touching the user's Corepack cache. */
export function ensurePnpmShim(context: WebHarness): string {
  const pnpm = resolvePnpmScript()
  const binDir = join(context.runDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const node = process.execPath
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'pnpm.cmd'),
      `@echo off\r\n"${node}" "${pnpm}" %*\r\n`,
      'utf8',
    )
  } else {
    const path = join(binDir, 'pnpm')
    writeFileSync(path, `#!/bin/sh\nexec "${node}" "${pnpm}" "$@"\n`, 'utf8')
    chmodSync(path, 0o755)
  }
  context.pnpmDir = binDir
  return binDir
}

export async function initProfile(context: WebHarness, label: string, home: string): Promise<string> {
  const result = runDsh(context, label, ['--profile', WEB_PROFILE, '--dump-config'], home)
  for (const expected of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!result.stdout.includes(expected)) throw new Error(`shipped web profile is missing ${expected}`)
  }
  return 'shipped web profile assembled'
}


export async function serveAndCheck(
  context: WebHarness,
  label: string,
  check: (url: string, stderr: string) => Promise<string>,
  home: string | undefined = context.home,
): Promise<string> {
  const stdoutPath = join(context.logDir, `${label}.web.out.log`)
  const stderrPath = join(context.logDir, `${label}.web.err.log`)
  const started = startToFiles(context.runner.command, context.runner.build(['web', '--no-open', '--host', '127.0.0.1', '--port', '0']), {
    cwd: repoRoot,
    env: childEnv(context, home ?? context.home),
    verbatim: context.runner.verbatim,
    stdoutPath,
    stderrPath,
  })

  let url: string | undefined
  try {
    url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(http:\/\/\S+)/, timeoutMs: context.options.timeoutMs })
    const status = await waitForHttp(url, context.options.timeoutMs)
    if (status !== 200) throw new Error(`GET ${url} returned ${status}, expected 200`)

    // Loader warnings are written while plugins activate; wait briefly so the
    // captured stderr is complete before asserting on it.
    await sleep(500)
    const detail = await check(url, readTextSafe(stderrPath))
    return `${detail} (${url.replace(/\?.*$/, '')})`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(redactLaunchTokens(`${message}\nstdout:\n${tail(stdoutPath, 15) || '(empty)'}\nstderr:\n${tail(stderrPath, 25) || '(empty)'}`))
  } finally {
    await stopChild(started.child, 15_000)
    if (url !== undefined) {
      const clean = new URL(url)
      clean.search = ''
      await waitForHttpClosed(clean.href, 10_000)
    }
  }
}

/** Raw logs stay local; reports and CI console must not expose launch tokens. */
export function redactLaunchTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&#"']+/g, '$1[redacted]')
}

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}


export function resolvePnpmScript(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DSH_PNPM']
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`DSH_PNPM does not exist: ${explicit}`)
    return explicit
  }

  const configured = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== '' ? env['DSH_HOME'] : undefined
  const homes = [configured, join(homedir(), '.dsh')].filter(
    (home, index, all): home is string => home !== undefined && all.indexOf(home) === index,
  )

  const candidates: string[] = []
  for (const home of homes) {
    const runtimes = join(home, 'dsh-runtimes')
    if (!existsSync(runtimes)) continue
    for (const entry of readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      candidates.push(join(runtimes, entry.name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))
    }
  }
  candidates.sort()
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new Error('cannot locate pnpm.cjs in the DSH runtime; set DSH_PNPM to the pnpm.cjs path')
  }
  return found
}
