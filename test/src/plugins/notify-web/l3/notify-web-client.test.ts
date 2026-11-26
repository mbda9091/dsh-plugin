import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { repoRoot } from "../../../common/harness/tmp.js"

/**
 * L3: the browser consumer of `notify-web`.
 *
 * The Client bundle is an esbuild IIFE. A VM provides a same-origin page, a
 * fake Notification API, a fake `fetch` that returns a controllable SSE stream,
 * and minimal storage/locks services. Tests drive the exact wire frames the Host
 * produces.
 */

interface NotificationOptions {
  readonly body?: string
  readonly tag?: string
  readonly requireInteraction?: boolean
}

interface FakeNotificationInstance {
  readonly title: string
  readonly options: NotificationOptions
  closed: boolean
  onclick: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

interface FakeNotificationConstructor {
  permission: string
  requestCount: number
  instances: FakeNotificationInstance[]
  requestPermission(): Promise<string>
}

interface ClientEntry {
  readonly id: string
  factory(require: (name: string) => unknown): {
    readonly inject: readonly string[]
    apply(ctx: unknown): void
  }
}

interface ApprovalShow {
  readonly type: 'show'
  readonly kind: 'approval'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly toolName: string
  readonly reason?: string
}

interface FixtureOptions {
  readonly serviceWorker?: object
  readonly pageUrl?: string
  readonly openSessionError?: boolean
  readonly notifyOnQuestion?: boolean
  readonly permission?: string
  readonly permissionRequest?: () => string | Promise<string>
  readonly desktop?: boolean
  readonly notification?: boolean
  readonly storage?: Map<string, string>
  readonly storageFailure?: 'read-write' | 'write'
  readonly manualTimers?: boolean
  readonly now?: () => number
  readonly locks?: { request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>): Promise<void> }
}

interface Fixture {
  receiveQuestion(sessionId: string, callId?: string): { answer(): void; fail(error: Error): void; result: Promise<{ answers: [] }> }
  readonly client: {
    readonly inject: readonly string[]
    apply(ctx: unknown): void
  }
  readonly notifications: FakeNotificationInstance[]
  readonly notification: FakeNotificationConstructor
  readonly opened: string[]
  readonly focusCount: number
  readonly fetchUrls: string[]
  readonly retryDelays: number[]
  readonly pendingRetries: number
  readonly global: Record<string, unknown>
  runRetry(): void
  apply(): void
  emitWindow(type: string): void
  sendSync(payload: unknown): void
  sendUpdate(payload: unknown): void
  closeStream(): void
  dispose(): void
}

const CLIENT_PATH = join(repoRoot, 'plugins', 'notify-web', 'lib', 'client.js')

function createNotification(request?: () => string | Promise<string>): FakeNotificationConstructor {
  class FakeNotification implements FakeNotificationInstance {
    static permission = 'granted'
    static requestCount = 0
    static instances: FakeNotificationInstance[] = []
    static requestPermission(): Promise<string> {
      FakeNotification.requestCount += 1
      const result = request?.() ?? 'granted'
      return Promise.resolve(result).then(permission => {
        FakeNotification.permission = permission
        return permission
      })
    }

    readonly title: string
    readonly options: NotificationOptions
    closed = false
    onclick: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(title: string, options: NotificationOptions) {
      this.title = title
      this.options = options
      FakeNotification.instances.push(this)
    }

    close(): void {
      if (this.closed) return
      this.closed = true
      this.onclose?.()
    }
  }
  return FakeNotification
}

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const notification = createNotification(options.permissionRequest)
  if (options.permission !== undefined) notification.permission = options.permission

  const windowListeners = new Map<string, Set<() => void>>()
  let focusCount = 0
  const windowObject = {
    location: { href: options.pageUrl ?? 'http://127.0.0.1:10089/' },
    history: { state: null, replaceState() {} },
    focus: () => {
      focusCount += 1
    },
    addEventListener: (type: string, handler: () => void) => {
      let handlers = windowListeners.get(type)
      if (handlers === undefined) {
        handlers = new Set()
        windowListeners.set(type, handlers)
      }
      handlers.add(handler)
    },
    removeEventListener: (type: string, handler: () => void) => {
      windowListeners.get(type)?.delete(handler)
    },
  }
  const emitWindow = (type: string): void => {
    for (const handler of [...(windowListeners.get(type) ?? [])]) handler()
  }

  const opened: string[] = []
  const uiWorkspace = {
    openSession: (sessionId: string) => {
      if (options.openSessionError) throw new Error('session navigation not ready')
      opened.push(sessionId)
    },
  }

  const zh: Record<string, string> = {
    'question.title': '需要你的回复',
    'question.body': '有问题等待你回答，请返回会话查看。',
    'approval.title': '需要确认权限',
    'approval.body': '{toolName} 正在请求授权',
    'approval.body.reason': '{toolName} 正在请求授权：{reason}',
    'approval.toolFallback': '工具',
    'turnEnd.completed.title': '对话已完成',
    'turnEnd.completed.body': '本轮回复已结束，可以回来查看了。',
    'turnEnd.maxTokens.title': '本轮已达到输出上限',
    'turnEnd.maxTokens.body': '任务可能尚未完成，请返回会话查看。',
    'turnEnd.error.title': '对话出错',
    'turnEnd.error.body': '{message}',
  }
  const en: Record<string, string> = {
    'question.title': 'Reply needed',
    'question.body': 'A question needs your answer; return to the conversation.',
    'approval.title': 'Approval required',
    'approval.body': '{toolName} is requesting permission',
    'approval.body.reason': '{toolName} is requesting permission: {reason}',
    'approval.toolFallback': 'Tool',
    'turnEnd.completed.title': 'Turn completed',
    'turnEnd.completed.body': 'The reply has finished; you can come back now.',
    'turnEnd.maxTokens.title': 'Output limit reached',
    'turnEnd.maxTokens.body': 'The task may be unfinished; return to the conversation.',
    'turnEnd.error.title': 'Turn failed',
    'turnEnd.error.body': '{message}',
  }
  const locale = {
    register: (_namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => {
      assert.deepEqual(JSON.parse(JSON.stringify(dictionaries)), { zh, en })
      return () => {}
    },
    bind: () => (key: string, params?: Record<string, string>) => {
      const template = zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match)
    },
  }

  const disposers: Array<() => void> = []
  type QuestionListener = (this: { sessionId: string }, request: {
    questions: Array<{ id: string; question: string }>; wait?: { callId: string }
  }, next: () => Promise<{ answers: [] }>) => Promise<{ answers: [] }>
  let questionListener: QuestionListener | undefined
  const ctx = {
    get: (name: string): unknown => {
      if (name === 'uiWorkspace') return uiWorkspace
      if (name === 'locale') return locale
      if (name === 'remote') return { $on: (_event: string, listener: QuestionListener) => {
        questionListener = listener
        return () => { questionListener = undefined }
      } }
      if (name === 'sessions') return { scopeOf: (owner: { sessionId: string }) => owner.sessionId }
      return undefined
    },
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  }

  const storage = options.storage ?? new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => {
      if (options.storageFailure === 'read-write') throw new Error('storage blocked')
      return storage.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (options.storageFailure !== undefined) throw new Error('storage write failed')
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
  }

  const fetchUrls: string[] = []
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetchImpl = async (input: URL | string, init: { signal: AbortSignal }): Promise<unknown> => {
    if (new URL(input).pathname.endsWith('/options')) return {
      ok: true, json: async () => ({ version: 3, notifyOnQuestion: options.notifyOnQuestion ?? true }),
    }
    fetchUrls.push(String(input))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      },
    })
    return { ok: true, status: 200, body }
  }

  const retryDelays: number[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  let loaded: ClientEntry | undefined
  const sandbox: Record<string, unknown> = {
    window: Object.assign(windowObject, {
      __ModuleLoader__: { load: (entry: ClientEntry) => { loaded = entry } },
    }),
    document: { baseURI: 'http://127.0.0.1:10089/' },
    navigator: { locks: options.locks, serviceWorker: options.serviceWorker },
    Notification: notification,
    localStorage,
    fetch: fetchImpl,
    URL,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    crypto: { randomUUID },
    console: { info: () => {}, warn: () => {}, error: () => {} },
    setTimeout: options.manualTimers === true ? (callback: () => void, delay: number) => {
      retryDelays.push(delay)
      timers.set(++timerId, callback)
      return timerId
    } : setTimeout,
    clearTimeout: options.manualTimers === true ? (id: number) => { timers.delete(id) } : clearTimeout,
  }
  const now = options.now
  if (now !== undefined) sandbox['Date'] = class extends Date { static override now(): number { return now?.() ?? Date.now() } }
  if (options.desktop === true) sandbox['dshDesktopBoot'] = {}
  if (options.notification === false) delete sandbox['Notification']

  const context = vm.createContext(sandbox)
  new vm.Script(readFileSync(CLIENT_PATH, 'utf8')).runInContext(context)
  assert.ok(loaded !== undefined, 'client.js must register a ModuleLoader entry')
  const plugin = loaded.factory(() => {
    throw new Error('client.js must not require a module')
  })

  let applied = false
  return {
    receiveQuestion(sessionId, callId) {
      assert.ok(questionListener, 'early Remote listener must be registered')
      let answer!: () => void
      let fail!: (error: Error) => void
      const next = new Promise<{ answers: [] }>((resolve, reject) => { answer = () => resolve({ answers: [] }); fail = reject })
      const result = questionListener.call({ sessionId }, {
        questions: [{ id: 'q', question: 'A or B?' }], ...(callId ? { wait: { callId } } : {}),
      }, () => next)
      return { answer, fail, result }
    },
    get client() {
      return plugin
    },
    notifications: notification.instances,
    notification,
    opened,
    get focusCount() {
      return focusCount
    },
    fetchUrls,
    retryDelays,
    global: sandbox,
    get pendingRetries() { return timers.size },
    runRetry() {
      const next = timers.entries().next().value
      assert.ok(next !== undefined, 'retry must be scheduled')
      timers.delete(next[0])
      next[1]()
    },
    apply() {
      if (applied) return
      applied = true
      plugin.apply(ctx)
    },
    emitWindow,
    sendSync(payload) {
      assert.ok(streamController !== undefined, 'SSE stream must be open')
      streamController.enqueue(frame('sync', payload))
    },
    sendUpdate(payload) {
      assert.ok(streamController !== undefined, 'SSE stream must be open')
      streamController.enqueue(frame('update', payload))
    },
    closeStream() {
      streamController?.close()
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
      disposers.length = 0
    },
  }
}

function approval(id: string, toolName: string, reason: string): ApprovalShow {
  return { type: 'show', kind: 'approval', id, sessionId: 'session-1', seq: 1, at: Date.now(), toolName, reason }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

describe('L3 notify-web client: wiring', () => {
  it('registers Remote observation before waiting for application UI services', () => {
    const fixture = createFixture()
    assert.deepEqual([...fixture.client.inject], ['remote'])
  })

  it('does nothing in the Desktop shell', () => {
    const fixture = createFixture({ desktop: true })
    fixture.apply()
    assert.equal(fixture.fetchUrls.length, 0)
  })

  it('does nothing when the browser exposes no Notification API', () => {
    const fixture = createFixture({ notification: false })
    assert.doesNotThrow(() => fixture.apply())
    assert.equal(fixture.fetchUrls.length, 0)
  })

  it('publishes permission/connection diagnostics and reconnects after a grant', async () => {
    const fixture = createFixture({ permission: 'default', permissionRequest: () => 'default' })
    fixture.apply()
    const debug = fixture.global['__NOTIFY_WEB__'] as {
      permission: string
      connected: boolean
      leader: boolean
      lastError?: string
      reconnect?: () => void
    } | undefined
    assert.equal(debug?.permission, 'default')
    assert.equal(debug?.connected, false)
    assert.equal(debug?.leader, false)
    assert.equal(typeof debug?.reconnect, 'function')
    assert.equal(fixture.fetchUrls.length, 0)

    fixture.notification.permission = 'granted'
    debug?.reconnect?.()
    await waitFor(() => fixture.fetchUrls.length === 1)
    await waitFor(() => debug?.leader === true)
    await waitFor(() => debug?.connected === true)
    assert.equal(debug?.lastError, undefined)
  })
})

describe('L3 notify-web client: SSE notifications', () => {
  it('starts notifications even when the clicked session cannot be opened during startup', async t => {
    const calls: string[] = []
    const serviceWorker = { addEventListener() {}, removeEventListener() {}, register: async () => ({
      active: {}, getNotifications: async () => [], showNotification: async (title: string) => { calls.push(title) },
    }) }
    const fixture = createFixture({ serviceWorker, openSessionError: true,
      pageUrl: 'http://127.0.0.1:10089/?notify-web-session=old&notify-web-id=old:turn-end:1' })
    t.after(() => fixture.dispose())
    assert.doesNotThrow(() => fixture.apply())
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 0, reset: false, pending: [approval('new:approval:1', 'test', 'test')], replay: [] })
    await waitFor(() => calls.length === 1)
  })
  it('keeps worker notifications on page exit, dedupes reopen and withdraws across owners', async t => {
    const notifications: Array<{ data: { id: string }; closed: boolean; close(): void }> = []
    const registration = {
      active: {},
      async getNotifications() { return notifications.filter(item => !item.closed) },
      async showNotification(_title: string, options: { data: { id: string } }) {
        const item = { data: options.data, closed: false, close() { item.closed = true } }
        notifications.push(item)
      },
    }
    const serviceWorker = { register: async () => registration, addEventListener() {}, removeEventListener() {} }
    const storage = new Map<string, string>()
    const first = createFixture({ serviceWorker, storage }); t.after(() => first.dispose())
    first.apply()
    await waitFor(() => first.fetchUrls.length === 1)
    const id = 'session-1:approval:keep'
    const sync = { version: 3, epoch: 'e', seq: 0, reset: true, pending: [approval(id, 'test', 'test')], replay: [] }
    first.sendSync(sync)
    await waitFor(() => notifications.length === 1)
    first.emitWindow('pagehide')
    first.dispose()
    assert.equal(notifications[0]!.closed, false)
    const second = createFixture({ serviceWorker, storage }); t.after(() => second.dispose())
    second.apply()
    await waitFor(() => second.fetchUrls.length === 1)
    second.sendSync(sync)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(notifications.length, 1, 'reopening must not show the same notification again')
    second.sendUpdate({ seq: 1, update: { type: 'withdraw', kind: 'approval', id } })
    await waitFor(() => notifications[0]!.closed)
    assert.equal(second.notifications.length, 0, 'persistent path must not create page notifications')
    second.dispose()
    const reopened = createFixture({ serviceWorker, storage, now: () => Date.now() + 60 * 60_000,
      pageUrl: `http://127.0.0.1:10089/?notify-web-session=session-1&notify-web-id=${encodeURIComponent(id)}` })
    t.after(() => reopened.dispose())
    reopened.apply()
    await waitFor(() => reopened.opened.length === 1)
    assert.deepEqual(reopened.opened, ['session-1'])
    await waitFor(() => reopened.fetchUrls.length === 1)
    reopened.sendSync(sync)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(notifications.length, 1, 'click receipt survives reset even when old seen records expired')
  })
  it('preserves a card rejection and withdraws its legacy notification', async t => {
    const fixture = createFixture(); t.after(() => fixture.dispose())
    fixture.apply()
    const request = fixture.receiveQuestion('s')
    await waitFor(() => fixture.notifications.length === 1)
    const error = new Error('card cancelled')
    request.fail(error)
    await assert.rejects(request.result, value => value === error)
    assert.equal(fixture.notifications[0]!.closed, true)
  })
  it('notifies a legacy request on receipt, passes the answer through, and closes on settlement', async t => {
    const fixture = createFixture(); t.after(() => fixture.dispose())
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    const request = fixture.receiveQuestion('s')
    await waitFor(() => fixture.notifications.length === 1)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 0, reset: true, pending: [], replay: [] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.notifications[0]!.closed, false, 'SSE cannot close a live request without a call ID')
    fixture.emitWindow('pagehide')
    assert.equal(fixture.notifications[0]!.closed, true)
    fixture.emitWindow('pageshow')
    await waitFor(() => fixture.notifications.length === 2)
    request.answer()
    assert.deepEqual(await request.result, { answers: [] })
    assert.equal(fixture.notifications[1]!.closed, true)
  })

  it('does not notify when a request settles before options arrive or questions are disabled', async t => {
    for (const disabled of [false, true]) {
      const fixture = createFixture({ notifyOnQuestion: !disabled }); t.after(() => fixture.dispose())
      fixture.apply()
      const request = fixture.receiveQuestion('s')
      if (!disabled) request.answer()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(fixture.notifications.length, 0)
      request.answer()
      assert.deepEqual(await request.result, { answers: [] })
    }
  })

  it('remembers receipt before the SSE candidate arrives without notifying from the tool alone', async t => {
    const fixture = createFixture(); t.after(() => fixture.dispose())
    fixture.apply()
    fixture.receiveQuestion('s', 'c')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.notifications.length, 0)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 1, pending: [{
      type: 'show', kind: 'question', id: 's:question:c', sessionId: 's', seq: 1, at: 1, question: 'Ready?',
    }], replay: [] })
    await waitFor(() => fixture.notifications.length === 1)
  })

  it('deduplicates a question across sync/replay, opens its session, and restores after reload', async () => {
    const storage = new Map<string, string>()
    const fixture = createFixture({ storage })
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    const question = { type: 'show', kind: 'question', id: 's:question:c', sessionId: 's',
      seq: 1, at: Date.now(), question: ' Which\n option? ' }
    const sync = { version: 3, epoch: 'e', seq: 1, pending: [question], replay: [question] }
    fixture.sendSync(sync)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.notifications.length, 0, 'tool events alone must not notify')
    fixture.receiveQuestion('s', 'c')
    await waitFor(() => fixture.notifications.length === 1)
    assert.equal(fixture.notifications[0]?.title, '需要你的回复')
    assert.equal(fixture.notifications[0]?.options.body, 'Which option?')
    fixture.sendSync(sync)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.notifications.length, 1)
    assert.ok([...storage.values()].every(value => !value.includes('Which')))
    fixture.notifications[0]?.onclick?.()
    assert.deepEqual(fixture.opened, ['s'])
    fixture.dispose()
    const reloaded = createFixture({ storage })
    reloaded.apply()
    await waitFor(() => reloaded.fetchUrls.length === 1)
    reloaded.sendSync(sync)
    await waitFor(() => reloaded.notifications.length === 1)
    reloaded.sendSync({ ...sync, seq: 2, pending: [], replay: [] })
    await waitFor(() => reloaded.notifications[0]?.closed === true)
    reloaded.dispose()
  })

  it('withdraws only the answered question and leaves other pending questions visible', async () => {
    const fixture = createFixture()
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    const first = { type: 'show', kind: 'question', id: 's:question:c1', sessionId: 's', seq: 1, at: 1, question: 'First?' }
    const second = { ...first, id: 's:question:c2', question: 'Second?' }
    fixture.sendSync({ version: 3, epoch: 'e', seq: 1, pending: [first, second], replay: [] })
    fixture.receiveQuestion('s', 'c1')
    fixture.receiveQuestion('s', 'c2')
    await waitFor(() => fixture.notifications.length === 2)
    fixture.sendUpdate({ version: 3, seq: 2, update: { ...first, type: 'withdraw' } })
    await waitFor(() => fixture.notifications[0]?.closed === true)
    assert.equal(fixture.notifications[1]?.closed, false)
    fixture.dispose()
  })

  it('rejects an unknown protocol without retrying or displaying unsupported payloads', async () => {
    const fixture = createFixture({ manualTimers: true })
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({ version: 99, epoch: 'e', seq: 0, pending: [approval('s:approval:a', 'x', '')], replay: [] })
    await waitFor(() => String((fixture.global.__NOTIFY_WEB__ as { lastError?: string }).lastError).includes('refresh'))
    assert.equal(fixture.pendingRetries, 0)
    assert.equal(fixture.notifications.length, 0)
    fixture.dispose()
  })

  it('shows a synced approval and opens its Session on click', async () => {
    const fixture = createFixture()
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({
      version: 3,
      epoch: 'epoch-1',
      seq: 0,
      reset: false,
      pending: [approval('session-1:approval:a1', 'pwsh', '  need\n access  ')],
      replay: [],
    })
    await waitFor(() => fixture.notifications.length === 1)
    const notification = fixture.notifications[0]
    assert.ok(notification !== undefined)
    assert.equal(notification.title, '需要确认权限')
    assert.equal(notification.options.body, 'pwsh 正在请求授权：need access')
    assert.equal(notification.options.tag, 'dsh-approval:session-1:approval:a1')

    notification.onclick?.()
    assert.equal(notification.closed, true)
    assert.equal(fixture.focusCount, 1)
    assert.deepEqual(fixture.opened, ['session-1'])
  })

  it('handles live show, withdraw, and turn-end updates', async () => {
    const fixture = createFixture()
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 0, reset: false, pending: [], replay: [] })
    fixture.sendUpdate({
      type: 'update',
      seq: 1,
      update: approval('session-1:approval:a1', 'pwsh', 'x'),
    })
    await waitFor(() => fixture.notifications.length === 1)
    fixture.sendUpdate({
      type: 'update',
      seq: 2,
      update: { type: 'withdraw', kind: 'approval', id: 'session-1:approval:a1', sessionId: 'session-1', seq: 2, at: Date.now() },
    })
    await waitFor(() => fixture.notifications[0]?.closed === true)
    assert.equal(fixture.notifications[0]?.closed, true)

    fixture.sendUpdate({
      type: 'update',
      seq: 3,
      update: { type: 'show', kind: 'turn-end', id: 'session-1:turn-end:3', sessionId: 'session-1', seq: 3, at: Date.now(), reasonKind: 'error', errorMessage: 'boom' },
    })
    await waitFor(() => fixture.notifications.length === 2)
    assert.equal(fixture.notifications[1]?.title, '对话出错')
    assert.equal(fixture.notifications[1]?.options.body, 'boom')
  })

  it('closes approvals that disappear from a reset sync', async () => {
    const fixture = createFixture()
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 0, reset: false, pending: [approval('session-1:approval:a1', 'pwsh', 'x')], replay: [] })
    await waitFor(() => fixture.notifications.length === 1)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 3, reset: true, pending: [], replay: [] })
    await waitFor(() => fixture.notifications[0]?.closed === true)
    assert.equal(fixture.notifications[0]?.closed, true)
  })

  it('resumes with the stored cursor after a stream ends', async (t) => {
    const fixture = createFixture({ manualTimers: true })
    t.after(() => fixture.dispose())
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({ version: 3, epoch: 'epoch-1', seq: 5, reset: false, pending: [], replay: [] })
    fixture.closeStream()
    await waitFor(() => fixture.pendingRetries === 1)
    fixture.runRetry()
    await waitFor(() => fixture.fetchUrls.length === 2)
    const second = new URL(fixture.fetchUrls[1] ?? '')
    assert.equal(second.searchParams.get('epoch'), 'epoch-1')
    assert.equal(second.searchParams.get('seq'), '5')
  })

  it('replays only approvals not withdrawn in the replay window', async () => {
    const fixture = createFixture()
    fixture.apply()
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.sendSync({
      version: 3,
      epoch: 'e',
      seq: 2,
      reset: false,
      pending: [approval('session-1:approval:a2', 'pwsh', 'pending')],
      replay: [
        { type: 'show', kind: 'approval', id: 'session-1:approval:a1', sessionId: 'session-1', seq: 1, at: Date.now(), toolName: 'pwsh', reason: 'gone' },
        { type: 'withdraw', kind: 'approval', id: 'session-1:approval:a1', sessionId: 'session-1', seq: 2, at: Date.now() },
      ],
    })
    await waitFor(() => fixture.notifications.some((notification) => notification.options.tag === 'dsh-approval:session-1:approval:a2'))
    const pendingNotification = fixture.notifications.find((notification) => notification.options.tag === 'dsh-approval:session-1:approval:a2')
    assert.ok(pendingNotification !== undefined)
    assert.equal(pendingNotification.closed, false)
  })
})

describe('L3 notify-web client: reconnect regressions', () => {
  it('does not wait for a legacy leader and explicitly negotiates the question protocol', async t => {
    let requested = ''
    const fixture = createFixture({ locks: { request: async (name, _options, callback) => {
      requested = name
      if (name === 'notify-web:/') return // A legacy tab holds this lock indefinitely.
      await callback()
    } } })
    t.after(() => fixture.dispose())
    fixture.apply()
    await waitFor(() => requested !== '')
    assert.equal(requested, 'notify-web:v3:/')
    await waitFor(() => fixture.fetchUrls.length === 1)
    assert.equal(new URL(fixture.fetchUrls[0]!).searchParams.get('protocol'), '3')
    fixture.sendSync({ version: 3, epoch: 'new', seq: 1, pending: [{
      type: 'show', kind: 'question', id: 'session-1:question:new', sessionId: 'session-1', seq: 1, at: 1000, question: 'A or B?',
    }], replay: [] })
    fixture.receiveQuestion('session-1', 'new')
    await waitFor(() => fixture.notifications.length === 1)
    assert.equal(fixture.notifications[0]!.options.body, 'A or B?')
  })
  it('keeps diagnostics accurate after active reconnects without Web Locks', async (t) => {
    const fixture = createFixture()
    t.after(() => fixture.dispose())
    fixture.apply()
    const debug = fixture.global['__NOTIFY_WEB__'] as {
      connected: boolean
      leader: boolean
      reconnect(): void
    }
    await waitFor(() => debug.connected)
    debug.reconnect()
    debug.reconnect()
    assert.equal(fixture.fetchUrls.length, 1, 'replacement waits for old consumer cleanup')
    await waitFor(() => fixture.fetchUrls.length === 2 && debug.connected)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(debug.leader, true)
    assert.equal(debug.connected, true)
    fixture.sendSync({ version: 3, epoch: 'e', seq: 1,
      pending: [approval('session-1:approval:a1', 'pwsh', 'x')], replay: [] })
    await waitFor(() => fixture.notifications.length === 1)
  })

  for (const storageFailure of ['read-write', 'write'] as const) {
    it(`keeps the in-memory cursor when storage fails (${storageFailure})`, async (t) => {
      const fixture = createFixture({ manualTimers: true, storageFailure, storage: new Map([
        ['notify-web:v3:cursor:/', JSON.stringify({ epoch: 'e', seq: 1 })],
      ]) })
      t.after(() => fixture.dispose())
      fixture.apply()
      fixture.sendSync({ version: 3, epoch: 'e', seq: 5, pending: [], replay: [] })
      fixture.closeStream()
      await waitFor(() => fixture.pendingRetries === 1)
      fixture.runRetry()
      await waitFor(() => fixture.fetchUrls.length === 2)
      const url = new URL(fixture.fetchUrls[1] ?? '')
      assert.equal(url.searchParams.get('epoch'), 'e')
      assert.equal(url.searchParams.get('seq'), '5')
      fixture.sendSync({ version: 3, epoch: 'e', seq: 6, pending: [], replay: [
        { type: 'show', kind: 'turn-end', id: 's:turn-end:6', sessionId: 's', seq: 6, at: 1, reasonKind: 'completed' },
      ] })
      await waitFor(() => fixture.notifications.length === 1)
      assert.equal(fixture.notifications[0]?.title, '对话已完成')
    })
  }

  it('loads the handover cursor when the lock is acquired, not while waiting', async (t) => {
    const storage = new Map<string, string>()
    let acquire: (() => Promise<void>) | undefined
    const fixture = createFixture({ storage, locks: { request: async (_name, _options, callback) => { acquire = callback } } })
    t.after(() => fixture.dispose())
    fixture.apply()
    assert.equal(fixture.fetchUrls.length, 0)
    storage.set('notify-web:v3:cursor:/', JSON.stringify({ epoch: 'other-leader', seq: 9 }))
    assert.ok(acquire !== undefined)
    const running = acquire()
    await waitFor(() => fixture.fetchUrls.length === 1)
    const url = new URL(fixture.fetchUrls[0] ?? '')
    assert.equal(url.searchParams.get('epoch'), 'other-leader')
    assert.equal(url.searchParams.get('seq'), '9')
    fixture.dispose()
    await running
  })

  it('does not re-show a dismissed approval on ordinary reconnect, but restores it after reload', async (t) => {
    const storage = new Map<string, string>()
    const fixture = createFixture({ storage, manualTimers: true })
    t.after(() => fixture.dispose())
    const sync = { version: 3, epoch: 'e', seq: 1, reset: false, pending: [approval('session-1:approval:a1', 'pwsh', 'x')], replay: [] }
    fixture.apply()
    fixture.sendSync(sync)
    await waitFor(() => fixture.notifications.length === 1)
    fixture.notifications[0]?.close()
    fixture.closeStream()
    await waitFor(() => fixture.pendingRetries === 1)
    fixture.runRetry()
    await waitFor(() => fixture.fetchUrls.length === 2)
    fixture.sendSync(sync)
    fixture.closeStream()
    await waitFor(() => fixture.pendingRetries === 1)
    assert.equal(fixture.notifications.length, 1)
    fixture.dispose()

    const reloaded = createFixture({ storage })
    t.after(() => reloaded.dispose())
    reloaded.apply()
    reloaded.sendSync(sync)
    await waitFor(() => reloaded.notifications.length === 1)
  })

  it('restores pending approvals after pagehide/pageshow and an epoch reset', async (t) => {
    const fixture = createFixture()
    t.after(() => fixture.dispose())
    const sync = { version: 3, epoch: 'e', seq: 1, pending: [approval('session-1:approval:a1', 'pwsh', 'x')], replay: [] }
    fixture.apply()
    fixture.sendSync(sync)
    await waitFor(() => fixture.notifications.length === 1)
    fixture.emitWindow('pagehide')
    assert.equal(fixture.notifications[0]?.closed, true)
    fixture.emitWindow('pageshow')
    await waitFor(() => fixture.fetchUrls.length === 2)
    fixture.sendSync(sync)
    await waitFor(() => fixture.notifications.length === 2)
    fixture.sendSync({ ...sync, epoch: 'new-epoch', reset: true })
    await waitFor(() => fixture.notifications.length === 3)
    assert.equal(fixture.notifications[1]?.closed, true)
  })

  it('backs off repeated EOF responses, caps delays, resets after stability, and cancels on disposal', async (t) => {
    let now = 0
    const fixture = createFixture({ manualTimers: true, now: () => now })
    t.after(() => fixture.dispose())
    fixture.apply()
    for (let index = 0; index < 8; index += 1) {
      fixture.closeStream()
      await waitFor(() => fixture.pendingRetries === 1)
      assert.equal(fixture.fetchUrls.length, index + 1, 'no fetch before the retry timer fires')
      const delay = fixture.retryDelays[index]
      const base = Math.min(30_000, 500 * 2 ** index)
      assert.ok(delay !== undefined && delay >= base && delay <= Math.min(30_000, base * 1.25))
      fixture.runRetry()
      await waitFor(() => fixture.fetchUrls.length === index + 2)
    }
    now += 30_000
    fixture.closeStream()
    await waitFor(() => fixture.pendingRetries === 1)
    const stableDelay = fixture.retryDelays.at(-1)
    assert.ok(stableDelay !== undefined && stableDelay >= 500 && stableDelay <= 625)
    fixture.dispose()
    assert.equal(fixture.pendingRetries, 0)
    assert.equal(fixture.fetchUrls.length, 9)
  })
})

describe('L3 notify-web client: permission', () => {
  it('requests permission immediately without events or gestures, then starts the stream', async () => {
    const fixture = createFixture({ permission: 'default' })
    fixture.apply()
    assert.equal(fixture.notification.requestCount, 1)
    assert.equal(fixture.fetchUrls.length, 0)
    fixture.emitWindow('pointerdown')
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.emitWindow('keydown')
    assert.equal(fixture.notification.requestCount, 1)
    fixture.dispose()
  })

  it('does not duplicate a pending startup permission request on interaction', async () => {
    let resolve!: (permission: string) => void
    const permission = new Promise<string>(done => { resolve = done })
    const fixture = createFixture({ permission: 'default', permissionRequest: () => permission })
    fixture.apply()
    fixture.emitWindow('pointerdown')
    fixture.emitWindow('keydown')
    assert.equal(fixture.notification.requestCount, 1)
    assert.equal(fixture.fetchUrls.length, 0)
    resolve('granted')
    await waitFor(() => fixture.fetchUrls.length === 1)
    fixture.dispose()
  })

  for (const failure of ['default', 'reject', 'throw'] as const) {
    it(`falls back to one gesture after startup permission ${failure}`, async () => {
      let requests = 0
      const fixture = createFixture({ permission: 'default', permissionRequest: () => {
        if (++requests > 1) return 'granted'
        if (failure === 'throw') throw new Error('user activation required')
        if (failure === 'reject') return Promise.reject(new Error('user activation required'))
        return 'default'
      } })
      fixture.apply()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(fixture.notification.requestCount, 1)
      assert.equal(fixture.fetchUrls.length, 0)
      fixture.emitWindow('pointerdown')
      fixture.emitWindow('keydown')
      await waitFor(() => fixture.fetchUrls.length === 1)
      assert.equal(fixture.notification.requestCount, 2)
      fixture.dispose()
    })
  }

  it('does not prompt on every gesture when the fallback is also dismissed', async () => {
    const fixture = createFixture({ permission: 'default', permissionRequest: () => 'default' })
    fixture.apply()
    await new Promise(resolve => setImmediate(resolve))
    fixture.emitWindow('keydown')
    await new Promise(resolve => setImmediate(resolve))
    fixture.emitWindow('pointerdown')
    fixture.emitWindow('keydown')
    assert.equal(fixture.notification.requestCount, 2)
    assert.equal(fixture.fetchUrls.length, 0)
    fixture.dispose()
  })

  for (const permission of ['granted', 'denied']) {
    it(`does not request permission already ${permission}`, () => {
      const fixture = createFixture({ permission })
      fixture.apply()
      fixture.emitWindow('pointerdown')
      fixture.emitWindow('keydown')
      assert.equal(fixture.notification.requestCount, 0)
      assert.equal(fixture.fetchUrls.length, permission === 'granted' ? 1 : 0)
      fixture.dispose()
    })
  }

  it('does not retry or subscribe after the startup request is denied', async () => {
    const fixture = createFixture({ permission: 'default', permissionRequest: () => 'denied' })
    fixture.apply()
    await new Promise(resolve => setImmediate(resolve))
    fixture.emitWindow('pointerdown')
    fixture.emitWindow('keydown')
    assert.equal(fixture.notification.requestCount, 1)
    assert.equal(fixture.fetchUrls.length, 0)
    fixture.dispose()
  })

  for (const result of ['granted', 'default']) {
    it(`ignores a late ${result} permission result after disposal`, async () => {
      let resolve!: (permission: string) => void
      const permission = new Promise<string>(done => { resolve = done })
      const fixture = createFixture({ permission: 'default', permissionRequest: () => permission })
      fixture.apply()
      fixture.dispose()
      resolve(result)
      await new Promise(resolve => setImmediate(resolve))
      fixture.emitWindow('pointerdown')
      assert.equal(fixture.notification.requestCount, 1)
      assert.equal(fixture.fetchUrls.length, 0)
    })
  }
})
