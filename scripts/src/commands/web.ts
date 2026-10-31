import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { envValue } from '../core/config.js'
import type { ConfigOverrides, RepoConfig } from '../core/config.js'
import { requireFile } from '../core/config-tools.js'
import { inspectWebPatch } from '../core/web-patch.js'
import { startToFiles, stopChild, waitForServerUrl, waitForHttp } from '../core/exec.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { repoRoot } from '../core/repo.js'
import { loadCommandContext, configuredDsh, configuredPnpm } from '../core/command-context.js'
import { writePnpmShim } from '../core/pnpm.js'
import { existsSync } from 'node:fs'
import { acquireDevelopmentLock, developmentPaths, initializeDevelopment, developmentEnvironment, validateDevelopmentPaths, validateDevelopmentTree, removeDevelopment } from '../core/development.js'
import { checkDevelopmentPort, createDevelopmentControl, developmentStatus, stopDevelopment } from '../core/development-process.js'
import { runStatus } from './status.js'

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
      if (forward.includes(name)) throw new Error(`${name} may only be specified once`)
      if (name === '--port' && !/^\d+$/.test(value)) throw new Error('--port must be an integer from 0 to 65535')
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

/** Foreground supervisor; status/stop/reset are available from another terminal. */
export async function runWeb(args: readonly string[], root: string = repoRoot, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const action = ['init', 'start', 'status', 'stop', 'reset'].includes(args[0] ?? '') ? args[0]! : 'start'
  const rest = args[0] === action ? args.slice(1) : args
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log('Usage: node scripts/bootstrap.mjs web [init|start|status|stop|reset]')
    console.log('start (default): [--open|--no-open] [--browser edge|default] [--browser-path PATH] [--startup-timeout MS] [--port PORT] [--host 127.0.0.1|::1|localhost]')
    console.log('reset: preview by default; --yes stops the owned instance and deletes only managed data. init/start never import personal configuration.')
    return 0
  }
  if (action !== 'start') {
    if (rest.some(arg => action !== 'reset' || arg !== '--yes')) throw new Error(`unsupported web ${action} option`)
    const context = loadCommandContext({}, root, env, 'development')
    const p = developmentPaths(root)
    validateDevelopmentPaths(context)
    if (action === 'status') {
      if (!existsSync(p.directory)) { console.log('development: uninitialized; run web init'); return 0 }
      validateDevelopmentTree(context)
      console.log(`development: ${await developmentStatus(context)}`)
      return existsSync(join(p.profile, 'package.json')) ? runStatus({}, context) : 0
    }
    if (action === 'stop') { await stopDevelopment(context); console.log('development stopped; data retained'); return 0 }
    const release = acquireDevelopmentLock(context)
    try {
      if (action === 'init') { initializeDevelopment(context); console.log(`development initialized: ${p.directory}`); return 0 }
      validateDevelopmentTree(context)
      console.log(`reset scope: ${p.directory} (home, store, logs, patch and management records); verified plugin links are unlinked, source is retained`)
      if (!rest.includes('--yes')) { console.log('preview only; execute with web reset --yes'); return 0 }
      await stopDevelopment(context)
      removeDevelopment(context)
      console.log('development reset; run web init to recreate')
      return 0
    } finally { release() }
  }
  const parsed = webArguments(rest)
  const context = loadCommandContext(parsed.overrides, root, env, 'development')
  const { config } = context
  const runner = configuredDsh(context, true), pnpm = configuredPnpm(context)
  const p = developmentPaths(root)
  const release = acquireDevelopmentLock(context)
  let locked = true
  let interrupted = false
  let requestedStop = false
  let started: ReturnType<typeof startToFiles> | undefined
  let control: Awaited<ReturnType<typeof createDevelopmentControl>> | undefined
  let stopped: Promise<void> | undefined
  const stop = (): Promise<void> => started ? stopped ??= stopChild(started.child) : Promise.resolve()
  const signal = (): void => { interrupted = true; void stop().catch(() => {}) }
  try {
    if (existsSync(p.runtime)) throw new Error(`development instance already recorded: ${await developmentStatus(context)}`)
    const port = parsed.forward.includes('--port') ? Number(parsed.forward[parsed.forward.indexOf('--port') + 1]) : 3000
    const host = parsed.forward.includes('--host') ? parsed.forward[parsed.forward.indexOf('--host') + 1]! : '127.0.0.1'
    await checkDevelopmentPort(port, host)
    initializeDevelopment(context)
    validateDevelopmentTree(context)
    const inspection = inspectWebPatch(p.patch, root)
    for (const warning of inspection.warnings) console.warn(`web: ${warning}`)
    if (config.web.openBrowser && config.web.browser === 'edge') {
      if (config.web.browserPath === null) throw new Error('web.browserPath: required for Edge; use --browser default or --no-open')
      requireFile(config.web.browserPath, 'web.browserPath')
    }
    writePnpmShim(p.bin, pnpm)
    control = await createDevelopmentControl(context, () => { requestedStop = true; void stop().catch(() => {}) })
    started = startToFiles(runner.command, runner.build(['web', '--patch', p.patch, '--no-open', '--host', host, '--port', String(port)]), {
      cwd: root, env: { ...developmentEnvironment(context), ...runner.env }, verbatim: runner.verbatim,
      stdoutPath: join(p.logs, 'web.out.log'), stderrPath: join(p.logs, 'web.err.log'),
    })
    control.update(started.child.pid)
    process.on('SIGINT', signal); process.on('SIGTERM', signal)
    const deadline = Date.now() + config.web.startupTimeoutMs
    const url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(https?:\/\/\S+)/, timeoutMs: config.web.startupTimeoutMs })
    const parsedUrl = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname) || (port !== 0 && Number(parsedUrl.port || 80) !== port)) throw new Error('DSH changed the requested development address/port')
    const status = await waitForHttp(url, Math.max(1, deadline - Date.now()))
    if (status !== 200) throw new Error(`development Web readiness returned HTTP ${status}`)
    control.update(started.child.pid, url)
    release(); locked = false
    console.log(`dsh web: ${url}`)
    if (config.web.openBrowser && !interrupted && !requestedStop) await openBrowser(config.web, url, env)
    if (started.child.exitCode === null && started.child.signalCode === null) {
      await new Promise<void>(resolve => { started!.child.once('exit', () => resolve()) })
    }
    return interrupted ? 130 : requestedStop ? 0 : started.child.exitCode ?? 1
  } catch (error) {
    if (interrupted) return 130
    if (requestedStop) return 0
    throw new Error(redactLaunchTokens(error instanceof Error ? error.message : String(error)))
  } finally {
    process.off('SIGINT', signal)
    process.off('SIGTERM', signal)
    try { await stop(); await control?.close() } finally { if (locked) release() }
  }
}
