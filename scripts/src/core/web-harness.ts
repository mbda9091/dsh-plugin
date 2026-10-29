import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DshRunner } from './dsh-cli.js'
import { runToFiles, sleep, startToFiles, stopChild, tail, waitForHttp, waitForHttpClosed, waitForServerUrl } from './exec.js'
import type { RunResult } from './exec.js'
import { repoRoot } from './repo.js'
import { commandEnv, configuredPnpm } from './command-context.js'
import type { CommandContext } from './command-context.js'
import { writePnpmShim } from './pnpm.js'

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
  readonly settings: CommandContext
  readonly runner: DshRunner
  readonly home: string
  readonly runDir: string
  readonly logDir: string
  readonly options: { readonly timeoutMs: number }
  pnpmDir?: string | undefined
}
export function childEnv(context: WebHarness, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...commandEnv(context.settings),
    ...context.runner.env,
  }
  for (const key of Object.keys(env)) {
    if (['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'PNPM_CONFIG_STORE_DIR', 'NPM_CONFIG_STORE_DIR'].includes(key.toUpperCase())) delete env[key]
  }
  env.DSH_HOME = home
  env.DSH_PROFILE = WEB_PROFILE
  // Keep both pnpm 11 and older runtime stores inside this disposable run.
  env.pnpm_config_store_dir = join(context.runDir, 'pnpm-store')
  env.npm_config_store_dir = join(context.runDir, 'pnpm-store')
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
  const pnpm = configuredPnpm(context.settings)
  const binDir = join(context.runDir, 'bin')
  writePnpmShim(binDir, pnpm)
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
