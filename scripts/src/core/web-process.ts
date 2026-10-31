import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isRecord } from './json.js'
import { sleep } from './exec.js'

export interface WebProcessScope {
  readonly runtime: string
  readonly owner: string
  validate(): void
}

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

function readRuntime(scope: WebProcessScope): Runtime | undefined {
  scope.validate()
  const p = scope
  if (!existsSync(p.runtime)) return undefined
  const value: unknown = JSON.parse(readFileSync(p.runtime, 'utf8'))
  if (!isRecord(value) || value.version !== 1 || value.owner !== scope.owner || typeof value.run !== 'string'
    || typeof value.token !== 'string' || !Number.isInteger(value.controlPort) || Number(value.controlPort) < 1 || Number(value.controlPort) > 65535
    || !['starting', 'running', 'stopping'].includes(String(value.state))) throw new Error('invalid Web process identity; manual inspection required')
  return value as unknown as Runtime
}

async function control(scope: WebProcessScope, action: 'status' | 'stop'): Promise<Runtime | undefined> {
  const runtime = readRuntime(scope)
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
    throw new Error('Web process identity cannot be verified; no PID was signalled. Inspect runtime.json and logs; after proving supervisor AND child have exited, remove runtime.json manually')
  }
}

export async function webProcessStatus(scope: WebProcessScope): Promise<string> {
  const runtime = await control(scope, 'status')
  return runtime ? `${runtime.state} run=${runtime.run} pid=${runtime.childPid ?? runtime.pid}${runtime.url ? ` ${runtime.url}` : ''}` : 'stopped'
}

export async function stopWebProcess(scope: WebProcessScope): Promise<void> {
  const runtime = await control(scope, 'stop')
  if (!runtime) return
  const deadline = Date.now() + 25_000
  while (readRuntime(scope)?.run === runtime.run) {
    if (Date.now() >= deadline) throw new Error('Web stop timed out; process record retained')
    await sleep(100)
  }
}

/** The live supervisor owns the ChildProcess handle. Other commands authenticate
 * to it; recorded PIDs are diagnostic only and are never kill targets. */
export async function createWebProcessControl(scope: WebProcessScope, stop: () => void) {
  scope.validate()
  const p = scope
  if (existsSync(p.runtime)) throw new Error(`Web instance already recorded: ${await webProcessStatus(scope)}`)
  const runtime: Runtime = { version: 1, owner: scope.owner, run: randomUUID(), token: randomUUID(), controlPort: 0, pid: process.pid, state: 'starting' }
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
      scope.validate()
      if (readRuntime(scope)?.run !== runtime.run) throw new Error('Web runtime record changed')
      if (childPid !== undefined) runtime.childPid = childPid
      if (url !== undefined) { runtime.url = new URL(url).origin; runtime.state = 'running' }
      writeFileSync(p.runtime, JSON.stringify(runtime, null, 2), { mode: 0o600 })
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      scope.validate()
      if (readRuntime(scope)?.run !== runtime.run) throw new Error('Web runtime record changed; retained for inspection')
      unlinkSync(p.runtime)
    },
  }
}
