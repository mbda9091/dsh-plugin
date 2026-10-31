import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import type { CommandContext } from './command-context.js'
import { developmentPaths, readDevelopmentOwner, validateDevelopmentPaths } from './development.js'
import { isRecord } from './json.js'
import { sleep } from './exec.js'

interface Runtime {
  version: 1
  owner: string
  run: string
  token: string
  controlPort: number
  pid: number
  childPid?: number
  state: 'starting' | 'running' | 'stopping'
  url?: string
}

function readRuntime(context: CommandContext): Runtime | undefined {
  const owner = readDevelopmentOwner(context), p = developmentPaths(context.root)
  if (!existsSync(p.runtime)) return undefined
  const value: unknown = JSON.parse(readFileSync(p.runtime, 'utf8'))
  if (!isRecord(value) || value.version !== 1 || value.owner !== owner.id || typeof value.run !== 'string'
    || typeof value.token !== 'string' || !Number.isInteger(value.controlPort) || Number(value.controlPort) < 1 || Number(value.controlPort) > 65535
    || !['starting', 'running', 'stopping'].includes(String(value.state))) throw new Error('invalid development process identity; manual inspection required')
  return value as unknown as Runtime
}

async function control(context: CommandContext, action: 'status' | 'stop'): Promise<Runtime | undefined> {
  const runtime = readRuntime(context)
  if (!runtime) return undefined
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.controlPort}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(3000), redirect: 'error',
    })
    const value: unknown = await response.json()
    if (!response.ok || !isRecord(value) || value.run !== runtime.run || value.owner !== runtime.owner) throw new Error('identity mismatch')
    return value as unknown as Runtime
  } catch {
    throw new Error('development process identity cannot be verified; no PID was signalled. Inspect runtime.json and logs; after proving supervisor AND child have exited, remove runtime.json manually')
  }
}

export async function developmentStatus(context: CommandContext): Promise<string> {
  const runtime = await control(context, 'status')
  return runtime ? `${runtime.state} run=${runtime.run} pid=${runtime.childPid ?? runtime.pid}${runtime.url ? ` ${runtime.url}` : ''}` : 'stopped'
}

export async function stopDevelopment(context: CommandContext): Promise<void> {
  const runtime = await control(context, 'stop')
  if (!runtime) return
  const deadline = Date.now() + 25_000
  while (readRuntime(context)?.run === runtime.run) {
    if (Date.now() >= deadline) throw new Error('development stop timed out; process record retained')
    await sleep(100)
  }
}

/** Refuse an occupied port; DSH must never pick a different port silently. */
export async function checkDevelopmentPort(port: number, host: string): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('development Web must listen on loopback')
  await new Promise<void>((resolve, reject) => {
    const server = tcpServer()
    server.once('error', () => reject(new Error(`development port ${port} is occupied or unavailable; no process was stopped`)))
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  })
}

/** The live supervisor owns the ChildProcess handle. Other commands authenticate
 * to it; recorded PIDs are diagnostic only and are never kill targets. */
export async function createDevelopmentControl(context: CommandContext, stop: () => void) {
  const owner = readDevelopmentOwner(context), p = developmentPaths(context.root)
  if (existsSync(p.runtime)) throw new Error(`development instance already recorded: ${await developmentStatus(context)}`)
  const runtime: Runtime = { version: 1, owner: owner.id, run: randomUUID(), token: randomUUID(), controlPort: 0, pid: process.pid, state: 'starting' }
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${runtime.token}`) { res.writeHead(403).end(); return }
    if (req.url === '/stop' && req.method === 'POST') { runtime.state = 'stopping'; stop() }
    else if (req.url !== '/status' || req.method !== 'GET') { res.writeHead(404).end(); return }
    res.setHeader('Content-Type', 'application/json')
    const { token: _, ...publicState } = runtime
    res.end(JSON.stringify(publicState))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('control listener missing')
  runtime.controlPort = address.port
  try { writeFileSync(p.runtime, JSON.stringify(runtime, null, 2), { flag: 'wx', mode: 0o600 }) }
  catch (error) { server.close(); throw error }
  return {
    update(childPid: number | undefined, url?: string) {
      validateDevelopmentPaths(context)
      if (readRuntime(context)?.run !== runtime.run) throw new Error('development runtime record changed')
      if (childPid !== undefined) runtime.childPid = childPid
      if (url !== undefined) { runtime.url = new URL(url).origin; runtime.state = 'running' }
      writeFileSync(p.runtime, JSON.stringify(runtime, null, 2), { mode: 0o600 })
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      validateDevelopmentPaths(context)
      if (readRuntime(context)?.run !== runtime.run) throw new Error('development runtime record changed; retained for inspection')
      unlinkSync(p.runtime)
    },
  }
}
