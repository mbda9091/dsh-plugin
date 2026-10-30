import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPaths, envValue, loadRepoConfig } from '../core/config.js'
import type { ConfigOverrides, RepoConfig } from '../core/config.js'
import { requireFile, webDsh } from '../core/config-tools.js'
import { inspectWebPatch } from '../core/web-patch.js'
import { startToFiles, stopChild, waitForServerUrl } from '../core/exec.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { repoRoot } from '../core/repo.js'

export function webArguments(args: readonly string[]): { overrides: ConfigOverrides; forward: string[]; help: boolean } {
  const overrides: ConfigOverrides = {}
  const forward: string[] = []
  let help = false
  const names = new Set(['--dsh-cli', '--browser', '--browser-path', '--startup-timeout'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { forward.push(...args.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--no-open') { overrides.openBrowser = false; continue }
    if (arg === '--open') { overrides.openBrowser = true; continue }
    const split = arg.indexOf('=')
    const name = split < 0 ? arg : arg.slice(0, split)
    if (!names.has(name)) { forward.push(arg); continue }
    const value = split < 0 ? args[++i] : arg.slice(split + 1)
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${name} requires a value`)
    switch (name) {
      case '--dsh-cli': overrides.dshCli = value; break
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
    console.log('Usage: node scripts/bootstrap.mjs web [--open|--no-open] [--dsh-cli <path>] [--browser edge|default] [--browser-path <path>] [--startup-timeout <ms>] [DSH web options]')
    console.log('Run node scripts/bootstrap.mjs config init first. --port, --host and other DSH options are forwarded.')
    return 0
  }
  const { config } = loadRepoConfig(root, env, parsed.overrides)
  if (config.tools.dshCli === null) throw new Error('tools.dshCli: required; run config init or pass --dsh-cli')
  const runner = webDsh(config.tools.dshCli, env)
  const patch = configPaths(root).patch
  const inspection = inspectWebPatch(patch, root)
  for (const warning of inspection.warnings) console.warn(`web: ${warning}`)
  if (config.web.openBrowser && config.web.browser === 'edge') {
    if (config.web.browserPath === null) throw new Error('web.browserPath: required for Edge; use --browser default or --no-open')
    requireFile(config.web.browserPath, 'web.browserPath')
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-web-launch-'))
  const stdoutPath = join(directory, 'stdout.log')
  const stderrPath = join(directory, 'stderr.log')
  let interrupted = false
  let stopped: Promise<void> | undefined
  const started = startToFiles(runner.command, runner.build(['web', '--patch', patch, '--no-open', ...parsed.forward]), {
    cwd: root, env: { ...env, ...runner.env }, verbatim: runner.verbatim, stdoutPath, stderrPath,
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
    rmdirSync(directory)
  }
}
