import { readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { DshRunner } from './dsh-cli.js'
import { runToFilesAsync, sleep, startToFiles, stopOwnedTree, tail, waitForHttp, waitForHttpClosed, waitForServerUrl } from './exec.js'
import type { RunResult } from './exec.js'
import { repoRoot } from './repo.js'
import { commandEnv, configuredPnpm } from './command-context.js'
import type { CommandContext } from './command-context.js'
import { writePnpmShim } from './pnpm.js'
import { freshTestHome, packageEnvironment } from './test-isolation.js'

const WEB_PROFILE = 'web'

/** Never accept an existing home or a symlink escaping the workspace scratch area. */
export function freshHome(runDir: string, requested?: string): string {
  return freshTestHome(repoRoot, runDir, requested)
}

/** Shared disposable-profile lifecycle for L4 and L5. */
export interface WebHarness {
  readonly signal?: AbortSignal | undefined
  readonly settings: CommandContext
  readonly runner: DshRunner
  readonly home: string
  readonly runDir: string
  readonly logDir: string
  readonly options: { readonly timeoutMs: number }
  pnpmDir?: string | undefined
}
export function childEnv(context: WebHarness, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = packageEnvironment({
    ...commandEnv(context.settings),
    ...context.runner.env,
  }, context.runDir)
  for (const key of Object.keys(env)) {
    if (/^DSH_/i.test(key) && !['DSH_E2E_BROWSER'].includes(key.toUpperCase())) delete env[key]
  }
  env.DSH_HOME = home
  env.DSH_PROFILE = WEB_PROFILE
  env.DSH_PROFILE_DIR = join(home, 'profiles', WEB_PROFILE)
  // Keep both pnpm 11 and older runtime stores inside this disposable run.
  env.pnpm_config_store_dir = join(context.runDir, 'pnpm-store')
  env.npm_config_store_dir = join(context.runDir, 'pnpm-store')
  if (context.pnpmDir !== undefined) {
    env['PATH'] = env['PATH'] === undefined ? context.pnpmDir : `${context.pnpmDir}${delimiter}${env['PATH']}`
  }
  return env
}

export async function runDsh(
  context: WebHarness,
  label: string,
  args: readonly string[],
  home: string,
  timeoutMs = context.options.timeoutMs,
): Promise<RunResult> {
  const result = await runToFilesAsync(context.runner.command, context.runner.build(args), {
    cwd: context.runDir,
    signal: context.signal,
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
  const result = await runDsh(context, label, ['--profile', WEB_PROFILE, '--dump-config'], home)
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
  context.signal?.throwIfAborted()
  const stdoutPath = join(context.logDir, `${label}.web.out.log`)
  const stderrPath = join(context.logDir, `${label}.web.err.log`)
  const started = startToFiles(context.runner.command, context.runner.build(['web', '--no-open', '--host', '127.0.0.1', '--port', '0']), {
    cwd: context.runDir,
    env: childEnv(context, home ?? context.home),
    verbatim: context.runner.verbatim,
    stdoutPath,
    stderrPath,
    ownProcessTree: true,
  })

  let url: string | undefined
  try {
    url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(http:\/\/\S+)/, timeoutMs: context.options.timeoutMs, signal: context.signal })
    const status = await waitForHttp(url, context.options.timeoutMs, 300, context.signal)
    if (status !== 200) throw new Error(`GET ${url} returned ${status}, expected 200`)

    // Loader warnings are written while plugins activate; wait briefly so the
    // captured stderr is complete before asserting on it.
    await sleep(500)
    const detail = await check(url, readTextSafe(stderrPath))
    context.signal?.throwIfAborted()
    return `${detail} (${url.replace(/\?.*$/, '')})`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(redactLaunchTokens(`${message}\nstdout:\n${tail(stdoutPath, 15) || '(empty)'}\nstderr:\n${tail(stderrPath, 25) || '(empty)'}`))
  } finally {
    await stopOwnedTree(started.child)
    if (url !== undefined) {
      const clean = new URL(url)
      clean.search = ''
      await waitForHttpClosed(clean.href, 10_000)
    }
  }
}

/** Raw logs stay local; reports and CI console must not expose launch tokens. */
export function redactLaunchTokens(text: string): string {
  return text.replace(/([?&](?:token|access_token|auth|key)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:_authToken|password|secret|token)\s*[=:]\s*)[^\s,;"']+/gi, '$1[redacted]')
}

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
