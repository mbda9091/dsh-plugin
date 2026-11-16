import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '@mbda9091/notify-web'

/**
 * L3: the Web Host notification broker.
 *
 * The test drives the exact route the plugin registers on DSH Connection and
 * reads the SSE response directly, so no HTTP server or browser is involved.
 */

interface FakeAgent {
  readonly session: Session
}

interface Route {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

interface Frame {
  readonly event: string
  readonly data: unknown
}

function agents(): { list(): FakeAgent[]; roots(): FakeAgent[] } {
  const root = { session: Session.create(SessionId('root')) }
  const sub = { session: Session.create(SessionId('sub')) }
  return {
    list: () => [root, sub],
    roots: () => [root],
  }
}

function createHost(): {
  ctx: Context
  emit(event: string, ...args: unknown[]): void
  route(path?: string): Route
  session: Session
  dispose(): void
} {
  const listeners: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = []
  const disposers: Array<() => void> = []
  const agentRegistry = agents()
  const projections = new SessionProjectionRegistry(new Context())
  const routes = new Map<string, Route>()
  const connection = {
    fetch: {
      register(value: Route) {
        routes.set(value.path, value)
        return async () => {}
      },
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'agents') return agentRegistry
      if (name === 'sessionProjections') return projections
      if (name === 'connection') return connection
      if (name === 'profileContext') return { startedBundles: ['@deepseek-ai/dsh-web-app'] }
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((item) => item.event === event && item.handler === handler)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    effect(callback: () => () => void) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx: ctx as unknown as Context,
    session: agentRegistry.roots()[0]!.session,
    emit(event, ...args) {
      for (const listener of listeners.filter((item) => item.event === event)) listener.handler(...args)
    },
    route(path = '/api/notify-web/events') {
      const route = routes.get(path)
      assert.ok(route !== undefined, 'SSE route must be registered')
      return route
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      for (const listener of [...listeners]) {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
  }
}

function approvalAsked(id: string, seq = 1): unknown {
  return { type: 'approval/asked', seq, time: 1_000, data: { id, toolName: 'pwsh', reason: 'need' } }
}

function turnEnd(seq = 2): unknown {
  return { type: 'turn/end', seq, time: 1_001, data: { turn: 1, reason: { kind: 'completed' } } }
}

class SseReader {
  private buffer = ''
  private readonly decoder = new TextDecoder()
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly frames: Frame[] = []

  constructor(response: Response) {
    assert.ok(response.body !== null)
    this.reader = response.body.getReader()
  }

  async next(count = 1): Promise<Frame[]> {
    while (this.frames.length < count) {
      const { done, value } = await this.reader.read()
      if (done) break
      this.buffer += this.decoder.decode(value, { stream: true })
      let boundary = this.buffer.indexOf('\n\n')
      while (boundary >= 0) {
        this.frames.push(this.parse(this.buffer.slice(0, boundary)))
        this.buffer = this.buffer.slice(boundary + 2)
        boundary = this.buffer.indexOf('\n\n')
      }
    }
    return this.frames.splice(0, count)
  }

  async cancel(): Promise<void> {
    await this.reader.cancel()
  }

  private parse(frame: string): Frame {
    let event = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    return { event, data: data.length === 0 ? undefined : JSON.parse(data.join('\n')) as unknown }
  }
}

function protocolRequest(input: string, init?: RequestInit): Request {
  const url = new URL(input)
  url.searchParams.set('protocol', '3')
  return new Request(url, init)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('L3 notify-web host: SSE route', () => {
  it('exposes the question switch to the receiving page without session data', async t => {
    const host = createHost(); t.after(() => host.dispose())
    await apply(host.ctx, { notifyOnQuestion: false })
    const response = await host.route('/api/notify-web/options').fetch(new Request('http://localhost/api/notify-web/options'))
    assert.deepEqual(await response.json(), { version: 3, notifyOnQuestion: false })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
  it('rejects legacy clients before sending notifications they cannot understand', async t => {
    const host = createHost(); t.after(() => host.dispose())
    await apply(host.ctx)
    for (const query of ['', '?protocol=1']) {
      const response = await host.route().fetch(new Request(`http://localhost/api/notify-web/events${query}`))
      assert.equal(response.status, 426)
      await response.body?.cancel()
    }
  })
  it('never replays an answered question, even when its show remains in the cache', async t => {
    const host = createHost(); t.after(() => host.dispose())
    await apply(host.ctx)
    const connect = async (query = '') => {
      const reader = new SseReader(await host.route().fetch(protocolRequest(`http://localhost/api/notify-web/events${query}`)))
      const [frame] = await reader.next()
      await reader.cancel()
      return frame?.data as { epoch: string; seq: number; pending: Array<{ kind: string }>; replay: Array<{ type: string; kind: string }> }
    }
    const initial = await connect()
    const call = host.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('question'),
      name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Which?"}]}' })
    host.emit('session/event', host.session, call)
    assert.deepEqual((await connect()).pending.map(item => item.kind), ['question'])
    const answer = host.session.append('tool/result', { turn: 1, step: 1, message: {
      id: MessageId('answer'), role: 'tool', source: { kind: 'tool', callId: ToolCallId('question') },
      toolCallId: ToolCallId('question'), content: [{ type: 'text', text: '{"answers":[]}' }],
    } }, { surfaceOp: 'append' })
    host.emit('session/event', host.session, answer)
    const replay = await connect(`?epoch=${initial.epoch}&seq=0`)
    assert.deepEqual(replay.pending, [])
    assert.deepEqual(replay.replay.map(item => [item.type, item.kind]), [['withdraw', 'question']])
  })

  it('can disable questions without disabling existing completion notifications', async t => {
    const host = createHost(); t.after(() => host.dispose())
    await apply(host.ctx, { notifyOnQuestion: false })
    const reader = new SseReader(await host.route().fetch(protocolRequest('http://localhost/api/notify-web/events')))
    await reader.next()
    host.emit('session/event', host.session, host.session.append('tool/call', { turn: 1, step: 1,
      callId: ToolCallId('off'), name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Hidden?"}]}' }))
    host.emit('session/event', host.session, turnEnd())
    const [frame] = await reader.next()
    assert.equal((frame?.data as { update: { kind: string } }).update.kind, 'turn-end')
    await reader.cancel()
  })

  it('expires idle replay entries before reconnect while keeping current pending approvals', async (t) => {
    let now = 1_000
    t.mock.method(Date, 'now', () => now)
    const host = createHost()
    t.after(() => host.dispose())
    await apply(host.ctx, { approvalDelayMs: 0, replayWindowMs: 100 })
    const route = host.route()
    const first = new SseReader(await route.fetch(protocolRequest('http://localhost/api/notify-web/events')))
    const [initial] = await first.next()
    const epoch = (initial?.data as { epoch: string }).epoch
    await first.cancel()
    host.emit('session/event', { id: 'root' }, approvalAsked('pending'))
    await delay(10)
    host.emit('session/event', { id: 'root' }, turnEnd(2))
    const resume = async (): Promise<{ reset: boolean; replay: unknown[]; pending: Array<{ id: string }> }> => {
      const reader = new SseReader(await route.fetch(protocolRequest(`http://localhost/api/notify-web/events?epoch=${epoch}&seq=0`)))
      const [frame] = await reader.next()
      await reader.cancel()
      return frame?.data as { reset: boolean; replay: unknown[]; pending: Array<{ id: string }> }
    }
    now += 50
    const recent = await resume()
    assert.equal(recent.reset, false)
    assert.equal(recent.replay.length, 2)
    now += 51 // No broadcasts or heartbeat pruning between these two requests.
    const expired = await resume()
    assert.equal(expired.reset, true)
    assert.deepEqual(expired.replay, [])
    assert.deepEqual(expired.pending.map((update) => update.id), ['root:approval:pending'])
  })

  it('registers the authenticated GET route and starts with an empty sync', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    assert.equal(route.path, '/api/notify-web/events')
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.requestBody, 'buffered')

    const controller = new AbortController()
    const response = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events', { signal: controller.signal }))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = new SseReader(response)
    const frames = await reader.next(1)
    assert.equal(frames[0]?.event, 'sync')
    assert.deepEqual(frames[0]?.data, {
      version: 3,
      epoch: (frames[0]?.data as { epoch: string }).epoch,
      seq: 0,
      reset: false,
      pending: [],
      replay: [],
    })
    assert.equal('pending' in (frames[0]?.data as object), true)
    await reader.cancel()
    controller.abort()
    host.dispose()
  })

  it('streams approval, turn-end, and withdrawal updates', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    const controller = new AbortController()
    const response = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events', { signal: controller.signal }))
    const reader = new SseReader(response)
    await reader.next(1)

    host.emit('session/event', { id: 'root' }, approvalAsked('a1'))
    await delay(10)
    host.emit('session/event', { id: 'root' }, turnEnd(2))
    host.emit('session/event', { id: 'root' }, { type: 'approval/decided', seq: 3, time: 1_002, data: { id: 'a1', outcome: 'rejected' } })

    const frames = await reader.next(3)
    const updates = frames.map((frame) => frame.data as { seq: number; update: { type: string; kind?: string } })
    assert.deepEqual(updates.map((entry) => entry.update.type === 'show' ? entry.update.kind : entry.update.type), ['approval', 'turn-end', 'withdraw'])
    assert.deepEqual(updates.map((entry) => entry.seq), [1, 2, 3])
    await reader.cancel()
    controller.abort()
    host.dispose()
  })

  it('replays cached updates for a same-epoch cursor', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    const controller = new AbortController()
    const response = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events', { signal: controller.signal }))
    const reader = new SseReader(response)
    const [first] = await reader.next(1)
    const epoch = (first?.data as { epoch: string }).epoch
    await reader.cancel()
    host.emit('session/event', { id: 'root' }, approvalAsked('a1'))
    await delay(10)
    host.emit('session/event', { id: 'root' }, turnEnd(2))

    const replayResponse = await route.fetch(protocolRequest(
      `http://127.0.0.1/api/notify-web/events?epoch=${encodeURIComponent(epoch)}&seq=0`,
      { signal: controller.signal },
    ))
    const replayReader = new SseReader(replayResponse)
    const frames = await replayReader.next(1)
    const sync = frames[0]?.data as { reset: boolean; replay: Array<{ type: string; kind?: string }>; pending: unknown[] }
    assert.equal(sync.reset, false)
    assert.deepEqual(sync.replay.map((update) => update.kind ?? update.type), ['approval', 'turn-end'])
    await replayReader.cancel()
    controller.abort()
    host.dispose()
  })

  it('syncs a still-pending approval to a new connection', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    host.emit('session/event', { id: 'root' }, approvalAsked('a1'))
    await delay(10)
    const controller = new AbortController()
    const response = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events', { signal: controller.signal }))
    const reader = new SseReader(response)
    const [frame] = await reader.next(1)
    const sync = frame?.data as { pending: Array<{ id: string }> }
    assert.deepEqual(sync.pending.map((update) => update.id), ['root:approval:a1'])
    await reader.cancel()
    controller.abort()
    host.dispose()
  })

  it('does not replay an approval show that was already withdrawn', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    const controller = new AbortController()
    const first = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events', { signal: controller.signal }))
    const firstReader = new SseReader(first)
    const [initial] = await firstReader.next(1)
    const epoch = (initial?.data as { epoch: string }).epoch
    await firstReader.cancel()

    host.emit('session/event', { id: 'root' }, approvalAsked('a1'))
    await delay(10)
    host.emit('session/event', { id: 'root' }, { type: 'approval/decided', seq: 2, time: 1_001, data: { id: 'a1', outcome: 'rejected' } })

    const replayResponse = await route.fetch(protocolRequest(
      `http://127.0.0.1/api/notify-web/events?epoch=${encodeURIComponent(epoch)}&seq=0`,
      { signal: controller.signal },
    ))
    const replayReader = new SseReader(replayResponse)
    const [frame] = await replayReader.next(1)
    const sync = frame?.data as { replay: Array<{ type: string; id?: string; kind?: string }>; pending: unknown[] }
    assert.deepEqual(sync.pending, [])
    assert.deepEqual(sync.replay.map((update) => update.type === 'withdraw' ? update.type : update.kind), ['withdraw'])
    await replayReader.cancel()
    controller.abort()
    host.dispose()
  })

  it('returns 400 for a malformed cursor and resets for another epoch', async () => {
    const host = createHost()
    await apply(host.ctx, { approvalDelayMs: 0 })
    const route = host.route()
    const controller = new AbortController()
    const invalid = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events?epoch=e&seq=nope', { signal: controller.signal }))
    assert.equal(invalid.status, 400)

    const resetResponse = await route.fetch(protocolRequest('http://127.0.0.1/api/notify-web/events?epoch=other&seq=0', { signal: controller.signal }))
    const resetReader = new SseReader(resetResponse)
    const frames = await resetReader.next(1)
    assert.equal((frames[0]?.data as { reset: boolean }).reset, true)
    await resetReader.cancel()
    controller.abort()
    host.dispose()
  })
})
