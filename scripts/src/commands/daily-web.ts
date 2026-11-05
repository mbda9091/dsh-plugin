import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { commandEnv, configuredPnpm, loadCommandContext } from '../core/command-context.js'
import { inspectTarget } from '../core/formal-target.js'
import { repoRoot } from '../core/repo.js'
import { writePnpmShim } from '../core/pnpm.js'
import { requireFile } from '../core/config-tools.js'

/** Foreground argument wrapper. DSH owns its server, output and browser launch. */
export async function runDailyWeb(args: readonly string[], root = repoRoot, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/bootstrap.mjs web [--target NAME] [--port PORT] [--host HOST] [--open|--no-open]')
    console.log('Defaults: target macos-web, port 3080, host 127.0.0.1, --no-open. Runs DSH in the foreground; Ctrl+C exits.')
    console.log('No status/stop, runtime records or deployment delegation. Development lifecycle: dev-web.')
    return 0
  }
  let name = 'macos-web', port = '3080', host = '127.0.0.1', open = false
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (i === 0 && arg === 'start') continue
    if (arg === '--') continue
    if (arg === '--open' || arg === '--no-open') { open = arg === '--open'; continue }
    const split = arg.indexOf('=')
    const key = split < 0 ? arg : arg.slice(0, split)
    if (!['--target', '--port', '--host'].includes(key)) throw new Error(`unsupported daily Web option: ${key}; use web --help`)
    if (seen.has(key)) throw new Error(`${key} may only be specified once`)
    seen.add(key)
    const value = split < 0 ? args[++i] : arg.slice(split + 1)
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    if (key === '--target') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error('--target requires a valid configured name')
      name = value
    } else if (key === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer from 0 to 65535')
      port = value
    } else {
      if (!['127.0.0.1', '::1', 'localhost'].includes(value)) throw new Error('--host must be a loopback address')
      host = value
    }
  }
  const context = loadCommandContext({ target: name }, root, env, 'target')
  const { target, runner, directory: profile } = inspectTarget(context)
  if (target.surface !== 'web') throw new Error('daily Web requires a Web target with a plain-Node CLI')
  if (!existsSync(join(profile, 'package.json'))) throw new Error('daily Web requires an existing initialized profile; check the bound target home/profile')
  const patch = target.patch ?? null
  if (patch !== null) requireFile(patch, 'targets[].patch')
  const pnpm = configuredPnpm(context)
  console.log(`daily target: ${name}; home: ${target.home}; profile: ${target.profile}; CLI: ${target.dshCli}; patch: ${patch ?? 'none'}`)
  const bin = mkdtempSync(join(tmpdir(), 'dsh-web-pnpm-'))
  try {
    writePnpmShim(bin, pnpm)
    const childEnv = commandEnv(context)
    childEnv.PATH = `${bin}${delimiter}${childEnv.PATH ?? ''}`
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(runner.command, runner.build([
        '--profile', target.profile, ...(patch === null ? [] : ['--patch', patch]),
        ...(open ? [] : ['--no-open']), '--host', host, '--port', port,
      ]), { cwd: target.home, env: { ...childEnv, ...runner.env }, stdio: 'inherit', windowsHide: true })
      // Forward signals only to our live child handle; never use persisted PIDs.
      const interrupt = () => { child.kill('SIGINT') }
      const terminate = () => { child.kill('SIGTERM') }
      const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
      child.once('error', error => { cleanup(); reject(error) })
      child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)) })
    })
  } finally { rmSync(bin, { recursive: true, force: true }) }
}
