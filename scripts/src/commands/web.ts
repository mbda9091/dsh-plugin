import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { envValue } from '../core/config.js'
import type { ConfigOverrides, RepoConfig } from '../core/config.js'
import { requireFile } from '../core/config-tools.js'
import { inspectWebPatch } from '../core/web-patch.js'
import { startToFiles, stopChild, waitForServerUrl } from '../core/exec.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { repoRoot } from '../core/repo.js'
import { loadCommandContext, configuredDsh, configuredPnpm, commandEnv } from '../core/command-context.js'
import { writePnpmShim } from '../core/pnpm.js'
import { existsSync } from 'node:fs'
import { safeConfigPath } from '../core/config-transaction.js'

export function webArguments(args: readonly string[]): { overrides: ConfigOverrides; forward: string[]; help: boolean } {
  const overrides: ConfigOverrides = {}
  const forward: string[] = []
  let help = false
  const names = new Set(['--browser', '--browser-path', '--startup-timeout'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--no-open') { overrides.openBrowser = false; continue }
    if (arg === '--open') { overrides.openBrowser = true; continue }
    const split = arg.indexOf('=')
    const name = split < 0 ? arg : arg.slice(0, split)
    if (['--profile', '--home', '--patch', '--dsh-cli', '--profile-dir', '--web-url'].includes(name)) throw new Error(`${name} cannot redirect development Web; use the managed context`)
    if (!names.has(name)) {
      if (!['--port', '--host'].includes(name)) throw new Error(`unsupported development Web option: ${name}`)
      const value = split < 0 ? args[++i] : arg.slice(split + 1)
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
      forward.push(name, value); continue
    }
    const value = split < 0 ? args[++i] : arg.slice(split + 1)
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${name} requires a value`)
    switch (name) {
      case '--browser': overrides.browser = value; break
      case '--browser-path': overrides.browserPath = value; break
      case '--startup-timeout': overrides.startupTimeoutMs = Number(value); break
    }
  }
  return { overrides, forward, help }
}

async function openBrowser(config: RepoConfig['web'], url: string, env: NodeJS.ProcessEnv): Promise<void> {
  let command: string
  let args: string[]
  if (config.browser === 'edge') {
    command = requireFile(config.browserPath!, 'web.browserPath')
    args = [url]
  } else if (process.platform === 'win32') {
    command = join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32/rundll32.exe')
    // Invoke the Windows URL handler directly, with the URL as a single argument.
    args = ['url.dll,FileProtocolHandler', url]
  } else {
    command = 'open'
    args = [url]
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** Reads local config once; never generates a patch. OS temp files only capture
 * child output and are removed on exit. */
export async function runWeb(args: readonly string[], root: string = repoRoot, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = webArguments(args)
  if (parsed.help) {
    console.log('Usage: node scripts/bootstrap.mjs web [--open|--no-open] [--browser edge|default] [--browser-path <path>] [--startup-timeout <ms>] [--port PORT] [--host HOST]')
    console.log('Run config init/migrate first. Requires workspace DSH (M2) and managed development data (M3). Only --port and --host are forwarded.')
    return 0
  }
  const context = loadCommandContext(parsed.overrides, root, env, 'development')
  const { config } = context
  const runner = configuredDsh(context, true)
  const patch = join(root, '.local/dsh-dev/cordis.patch.yml')
  safeConfigPath(root, patch)
  if (!existsSync(patch)) throw new Error('managed development patch is not prepared; complete M3; personal Web patch is never imported')
  const pnpm = configuredPnpm(context)
  const inspection = inspectWebPatch(patch, root)
  for (const warning of inspection.warnings) console.warn(`web: ${warning}`)
  if (config.web.openBrowser && config.web.browser === 'edge') {
    if (config.web.browserPath === null) throw new Error('web.browserPath: required for Edge; use --browser default or --no-open')
    requireFile(config.web.browserPath, 'web.browserPath')
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-web-launch-'))
  writePnpmShim(directory, pnpm)
  const hostEnv = { ...commandEnv(context), ...runner.env }
  hostEnv.PATH = `${directory}${delimiter}${hostEnv.PATH ?? ''}`
  const stdoutPath = join(directory, 'stdout.log')
  const stderrPath = join(directory, 'stderr.log')
  let interrupted = false
  let stopped: Promise<void> | undefined
  const started = startToFiles(runner.command, runner.build(['web', '--patch', patch, '--no-open', ...parsed.forward]), {
    cwd: root, env: hostEnv, verbatim: runner.verbatim, stdoutPath, stderrPath,
  })
  // webDsh unwraps recognized shims: the child is the Node Host itself, not a
  // cmd.exe wrapper. Use the same lifecycle helper as L4/L5.
  const stop = (): Promise<void> => stopped ??= stopChild(started.child)
  const signal = (): void => { interrupted = true; void stop().catch(() => {}) }
  process.on('SIGINT', signal)
  process.on('SIGTERM', signal)
  try {
    const url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(https?:\/\/\S+)/, timeoutMs: config.web.startupTimeoutMs })
    console.log(`dsh web: ${url}`)
    if (config.web.openBrowser && !interrupted) await openBrowser(config.web, url, env)
    // No polling or runtime deadline for a server; only startup is bounded.
    if (started.child.exitCode === null && started.child.signalCode === null) {
      await new Promise<void>(resolve => { started.child.once('exit', () => resolve()) })
    }
    return interrupted ? 130 : started.child.exitCode ?? 1
  } catch (error) {
    if (interrupted) return 130
    throw new Error(redactLaunchTokens(error instanceof Error ? error.message : String(error)))
  } finally {
    process.off('SIGINT', signal)
    process.off('SIGTERM', signal)
    await stop()
    rmSync(stdoutPath, { force: true })
    rmSync(stderrPath, { force: true })
    rmSync(join(directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), { force: true })
    rmdirSync(directory)
  }
}
