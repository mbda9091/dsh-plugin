import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { commandEnv, configuredPnpm, loadCommandContext } from '../core/command-context.js'
import { inspectTarget } from '../core/formal-target.js'
import { digest, safeConfigPath } from '../core/config-transaction.js'
import { repoRoot } from '../core/repo.js'
import { writePnpmShim } from '../core/pnpm.js'
import { checkDevelopmentPort } from '../core/development-process.js'
import { createWebProcessControl, stopWebProcess, webProcessStatus } from '../core/web-process.js'
import { startToFiles, stopChild, waitForHttp, waitForServerUrl } from '../core/exec.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { openBrowser, webArguments } from './web.js'

/** Daily data is selected by an explicit configured target, never inherited
 * from the invoking DSH session. No installs, resets or development overlays. */
export async function runDailyWeb(args: readonly string[], root = repoRoot, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/bootstrap.mjs web [start|status|stop|check] [--target NAME]')
    console.log('After daily-launcher deploy, delegates to the deployed launcher. This convenience entry still needs the repository; use external dshweb for independent operation. check requires deployment.')
    console.log('Default target: daily; default address: 127.0.0.1:3080. Bind the daily target with its external plain-Node CLI, existing home and Web profile first.')
    console.log('start: [--open|--no-open] [--browser edge|default] [--browser-path PATH] [--startup-timeout MS] [--port PORT] [--host 127.0.0.1|::1|localhost]')
    console.log('Development: dev-web [init|start|status|stop|reset]; tests: l4/l5. Daily Web never installs plugins or resets data.')
    return 0
  }
  let name = 'daily'
  let selected = false
  const remaining: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--target' || arg.startsWith('--target=')) {
      if (selected) throw new Error('--target may only be specified once')
      selected = true
      name = arg === '--target' ? args[++i] ?? '' : arg.slice('--target='.length)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('--target requires a valid configured name')
    } else remaining.push(arg)
  }
  const locator = join(root, '.local/dsh-daily', name, 'deployment.json')
  safeConfigPath(root, locator)
  if (existsSync(locator)) {
    const deployed = JSON.parse(readFileSync(locator, 'utf8'))
    if (typeof deployed.node !== 'string' || typeof deployed.destination !== 'string') throw new Error('invalid daily deployment locator')
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(deployed.node, [join(deployed.destination, 'bin/dshweb.mjs'), ...remaining], { stdio: 'inherit', env, windowsHide: true })
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1))
    })
  }
  const action = ['start', 'status', 'stop'].includes(remaining[0] ?? '') ? remaining.shift()! : 'start'
  if (['init', 'reset'].includes(remaining[0] ?? '')) throw new Error('daily Web has no init/reset; use dev-web for managed development data')
  if (action !== 'start' && remaining.length) throw new Error(`unsupported web ${action} option`)
  const parsed = webArguments(remaining)
  const context = loadCommandContext({ ...parsed.overrides, target: name }, root, env, 'target')
  const { target, runner, directory: profile, identity } = inspectTarget(context)
  if (target.surface !== 'web') throw new Error('daily Web requires a Web target with a plain-Node CLI')
  // Refuse typo/new destinations instead of silently creating an empty history.
  if (!existsSync(join(profile, 'package.json'))) throw new Error('daily Web requires an existing initialized profile; check the bound target home/profile')
  const directory = join(root, '.local/dsh-daily', name)
  const runtime = join(directory, 'runtime.json')
  const logs = join(directory, 'logs'), bin = join(directory, 'bin'), lock = join(directory, 'operation.lock')
  const validate = () => {
    inspectTarget(context)
    for (const path of [directory, runtime, logs, bin, lock, join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), join(logs, 'web.out.log'), join(logs, 'web.err.log')]) safeConfigPath(root, path)
  }
  validate()
  const scope = { runtime, owner: digest(JSON.stringify({ root: realpathSync(root), name, identity })), validate }
  console.log(`daily target: ${name}; home: ${target.home}; profile: ${target.profile}; CLI: ${target.dshCli}`)
  if (action === 'status') { console.log(`daily: ${await webProcessStatus(scope)}`); return 0 }
  if (action === 'stop') { await stopWebProcess(scope); console.log('daily stopped; data retained'); return 0 }
  const pnpm = configuredPnpm(context)
  mkdirSync(directory, { recursive: true })
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }) }
  catch { throw new Error(`daily Web operation locked: ${lock}; inspect before manual recovery`) }
  let locked = true, interrupted = false, requestedStop = false
  let started: ReturnType<typeof startToFiles> | undefined
  let control: Awaited<ReturnType<typeof createWebProcessControl>> | undefined
  let stopped: Promise<void> | undefined
  const stop = () => started ? stopped ??= stopChild(started.child) : Promise.resolve()
  const signal = () => { interrupted = true; void stop().catch(() => {}) }
  try {
    if (existsSync(runtime)) throw new Error(`daily instance already recorded: ${await webProcessStatus(scope)}`)
    const port = parsed.forward.includes('--port') ? Number(parsed.forward[parsed.forward.indexOf('--port') + 1]) : 3080
    const host = parsed.forward.includes('--host') ? parsed.forward[parsed.forward.indexOf('--host') + 1]! : '127.0.0.1'
    await checkDevelopmentPort(port, host)
    for (const path of [logs, bin]) mkdirSync(path, { recursive: true })
    writePnpmShim(bin, pnpm)
    validate()
    control = await createWebProcessControl(scope, () => { requestedStop = true; void stop().catch(() => {}) })
    const childEnv = commandEnv(context)
    childEnv.PATH = `${bin}${delimiter}${childEnv.PATH ?? ''}`
    started = startToFiles(runner.command, runner.build(['--profile', target.profile, '--no-open', '--host', host, '--port', String(port)]), {
      cwd: target.home, env: { ...childEnv, ...runner.env }, verbatim: runner.verbatim,
      stdoutPath: join(logs, 'web.out.log'), stderrPath: join(logs, 'web.err.log'),
    })
    control.update(started.child.pid)
    process.on('SIGINT', signal); process.on('SIGTERM', signal)
    const timeout = context.config.web.startupTimeoutMs, deadline = Date.now() + timeout
    const url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(https?:\/\/\S+)/, timeoutMs: timeout })
    const address = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || (port !== 0 && Number(address.port || 80) !== port)) throw new Error('DSH changed the requested daily address/port')
    if (await waitForHttp(url, Math.max(1, deadline - Date.now())) !== 200) throw new Error('daily Web readiness failed')
    control.update(started.child.pid, url)
    validate(); unlinkSync(lock); locked = false
    console.log(`dsh web: ${url}`)
    if (context.config.web.openBrowser && !interrupted && !requestedStop) await openBrowser(context.config.web, url, env)
    if (started.child.exitCode === null && started.child.signalCode === null) await new Promise<void>(resolve => started!.child.once('exit', () => resolve()))
    return interrupted ? 130 : requestedStop ? 0 : started.child.exitCode ?? 1
  } catch (error) {
    if (interrupted) return 130
    if (requestedStop) return 0
    throw new Error(redactLaunchTokens(error instanceof Error ? error.message : String(error)))
  } finally {
    process.off('SIGINT', signal); process.off('SIGTERM', signal)
    try { await stop(); await control?.close() } finally { if (locked) { validate(); unlinkSync(lock) } }
  }
}
