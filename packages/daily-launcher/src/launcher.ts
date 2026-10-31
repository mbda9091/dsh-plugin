import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'
import { auditDaily, plainPath, readDailyConfig, separateDaily, validateDailyLocation, validateDailyTools } from '../../../scripts/.build/core/daily-contract.js'
import { createWebProcessControl, stopWebProcess, webProcessStatus } from '../../../scripts/.build/core/web-process.js'
import { startToFiles, stopChild, waitForHttp, waitForServerUrl } from '../../../scripts/.build/core/exec.js'

export async function run(root: string, configPath: string, args: string[], inherited = process.env): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'no-open': { type: 'boolean' }, open: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log('dshweb [start|status|stop|check] [--no-open|--open] [--port PORT] [--host 127.0.0.1|::1|localhost]'); return 0 }
  const action = positionals[0] ?? 'start'
  if (positionals.length > 1 || !['start', 'status', 'stop', 'check'].includes(action) || (action !== 'start' && Object.keys(values).length)) throw new Error('unsupported daily action/options; no init/reset')
  const c = readDailyConfig(configPath)
  validateDailyLocation(root, c)
  const state = join(root, 'state', c.instanceId), runtime = join(state, 'runtime.json'), lock = join(state, 'operation.lock')
  const paths = [state, runtime, lock, join(state, 'bin'), join(state, 'bin/pnpm.cmd'), join(state, 'logs'), join(state, 'logs/web.out'), join(state, 'logs/web.err')]
  const validate = () => { plainPath(root); paths.forEach(plainPath) }
  const scope = { runtime, owner: c.instanceId, validate }
  if (action === 'status') { console.log(await webProcessStatus(scope)); return 0 }
  if (action === 'stop') { await stopWebProcess(scope); console.log('daily stopped; data retained'); return 0 }
  validateDailyTools(c)
  if (!existsSync(join(c.target.directory, 'package.json'))) throw new Error('daily requires an existing initialized profile')
  const audit = auditDaily(c)
  if (action === 'check') {
    let status: string
    try { status = await webProcessStatus(scope) } catch { status = 'unverified process identity' }
    console.log(JSON.stringify({ version: 1, launcher: '1.0.0', instanceId: c.instanceId, host: c.host, target: c.target, packageManager: c.packageManager, ...audit, status }, null, 2))
    return audit.findings.length || status.startsWith('unverified') ? 1 : 0
  }
  if (audit.findings.some(f => f.kind === 'blocked')) throw new Error('daily dependency isolation check failed; run dshweb check')
  if (audit.findings.length) console.warn('daily configuration has manual review items; run dshweb check')
  const port = values.port === undefined ? c.web.port : Number(values.port), host = values.host ?? c.web.host
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('invalid loopback address/port')
  validate(); mkdirSync(state, { recursive: true })
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }) } catch { throw new Error('daily operation locked; inspect before recovery') }
  let locked = true, requested = false, interrupted = false
  let started: ReturnType<typeof startToFiles> | undefined
  let control: Awaited<ReturnType<typeof createWebProcessControl>> | undefined
  let stopping: Promise<void> | undefined
  const stop = () => started ? stopping ??= stopChild(started.child) : Promise.resolve()
  const signal = () => { interrupted = true; void stop().catch(() => {}) }
  try {
    if (existsSync(runtime)) throw new Error(`daily instance already recorded: ${await webProcessStatus(scope)}`)
    await new Promise<void>((resolve, reject) => {
      const server = createServer(); server.once('error', reject)
      server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
    })
    validate()
    mkdirSync(join(state, 'bin'), { recursive: true })
    const quote = (p: string) => p.replaceAll('%', '%%')
    writeFileSync(join(state, 'bin/pnpm.cmd'), `@echo off\r\n"${quote(c.host.node)}" "${quote(c.packageManager.script)}" %*\r\n`)
    const env = { ...inherited }
    for (const key of Object.keys(env)) if (/^(DSH_|ELECTRON_|NODE_OPTIONS$)/i.test(key)) delete env[key]
    env.DSH_HOME = c.target.home; env.DSH_PROFILE = c.target.profile; env.DSH_PROFILE_DIR = c.target.directory
    env.PATH = `${join(state, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`
    if (Object.hasOwn(env, 'Path')) delete env.Path
    control = await createWebProcessControl(scope, () => { requested = true; void stop().catch(() => {}) })
    started = startToFiles(c.host.node, [c.host.entry, 'web', '--no-open', '--host', host, '--port', String(port)], {
      cwd: c.target.home, env, ownProcessTree: true, stdoutPath: join(state, 'logs/web.out'), stderrPath: join(state, 'logs/web.err'),
    })
    control.update(started.child.pid)
    process.on('SIGINT', signal); process.on('SIGTERM', signal)
    const deadline = Date.now() + c.web.startupTimeoutMs
    const url = await waitForServerUrl(started, { urlPattern: /dsh web:\s*(https?:\/\/\S+)/, timeoutMs: c.web.startupTimeoutMs })
    const address = new URL(url)
    if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || port !== 0 && Number(address.port || 80) !== port) throw new Error('host changed requested loopback address/port')
    if (await waitForHttp(url, Math.max(1, deadline - Date.now())) !== 200) throw new Error('daily HTTP readiness failed')
    control.update(started.child.pid, url)
    validate(); unlinkSync(lock); locked = false
    console.log(`dsh web: ${url}`)
    if ((values.open || !values['no-open'] && c.web.openBrowser) && !requested && !interrupted) {
      if (c.web.browserPath) separateDaily(c.web.browserPath, c.isolation.forbiddenRoots)
      const child = c.web.browserPath ? spawn(c.web.browserPath, [url], { stdio: 'ignore', detached: true, windowsHide: true })
        : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', () => console.warn('browser could not be opened')); child.unref()
    }
    if (started.child.exitCode === null && started.child.signalCode === null) await new Promise<void>(resolve => started!.child.once('exit', () => resolve()))
    return interrupted ? 130 : requested ? 0 : started.child.exitCode ?? 1
  } catch (error) {
    if (interrupted || requested) return interrupted ? 130 : 0
    throw new Error((error instanceof Error ? error.message : 'daily start failed').replace(/([?&](?:token|auth|key)=)[^\s&]+/gi, '$1[redacted]'))
  } finally {
    process.off('SIGINT', signal); process.off('SIGTERM', signal)
    try { await stop(); await control?.close() } finally { if (locked) { validate(); unlinkSync(lock) } }
  }
}
