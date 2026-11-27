import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { LoginController, safeUrl } from '../../../../../plugins/codex-login/lib/controller.js'
import { KEY } from '../../../../../plugins/codex-login/lib/environment.js'
import { registerRoutes } from '../../../../../plugins/codex-login/lib/http.js'

/** Real AuthorizationService with memory-only credentials; never runs provider OAuth. */
function fixture(run?: (session: AuthorizationSession) => Promise<void>, timeout = 600_000) {
  const ctx = new Context()
  let record: CredentialRecord | undefined
  let profile: Record<string, unknown> = {}
  let configured = true
  let calls = 0
  let deletes = 0
  let readOnly = false
  const routes = new Map<string, ConnectionFetchRoute>()
  const credentials = {
    async describeRecord() { return { configured: record !== undefined, kind: record?.kind, writable: !readOnly } },
    async modifyRecord(_key: string, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      record = await mutate(record)
      ctx.emit('credentials/record-updated', KEY)
      return record
    },
    async deleteRecord() {
      if (readOnly) throw new Error('SYNTHETIC_SECRET_DELETE_ERROR')
      deletes++
      record = undefined
      ctx.emit('credentials/record-updated', KEY)
    },
  }
  ctx.provide('credentials', credentials as unknown as CredentialProvider)
  const auth = new AuthorizationService(ctx)
  ctx.provide('llm', {
    listProviders: () => configured ? [{ id: 'openai-codex', name: 'Codex' }] : [],
    listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'custom-row-id', settingsPath: ['providers', 'openai-codex'], nativeAuth: { oauth: true, env: [] } }],
  } as unknown as Context['llm'])
  ctx.provide('settings', { describe: () => [{ ns: 'custom-row-id', value: { providers: { 'openai-codex': profile } } }] } as unknown as Context['settings'])
  ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } } as unknown as Context['connection'])
  auth.registerFlow({ key: KEY, label: 'Test only', methods: [{ id: 'oauth', label: 'OAuth' }], async run(session) {
    calls++
    if (run) await run(session)
    else {
      const value = await session.prompt({ kind: 'text', message: 'SYNTHETIC_CODE_PROMPT' })
      assert.equal(value, 'SYNTHETIC_ANSWER')
      await session.commit({ kind: 'grant', payload: { token: 'SYNTHETIC_TOKEN' } })
    }
  } })
  const controller = new LoginController(ctx, timeout)
  ctx.on('credentials/record-updated', () => controller.changed())
  const unregister = registerRoutes(ctx, controller)
  const post = async (operation: string, data: object) => routes.get(`/api/codex-login/${operation}`)!.fetch(new Request('http://localhost/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  }))
  const requestId = () => `${Date.now()}-${randomUUID()}`
  const begin = async () => {
    const result = await controller.once(controller.epoch, requestId(), 'begin')
    assert.ok('attemptId' in result)
    return result.attemptId
  }
  return {
    controller, auth, routes, post, begin, requestId,
    configure(value: boolean) { configured = value },
    profile(value: Record<string, unknown>) { profile = value },
    setRecord(value: CredentialRecord) { record = value },
    readOnly() { readOnly = true },
    get calls() { return calls }, get deletes() { return deletes },
    async dispose() { controller.dispose(); await unregister(); await ctx.fiber.dispose() },
  }
}

describe('L3 codex-login native authorization controller', () => {
  it('deduplicates a lost begin response and isolates prompts from public status', async () => {
    const f = fixture()
    try {
      const requestId = f.requestId()
      const one = f.controller.once(f.controller.epoch, requestId, 'begin')
      const two = f.controller.once(f.controller.epoch, requestId, 'begin')
      assert.equal(one, two)
      const result = await one
      assert.ok('attemptId' in result)
      assert.equal(f.calls, 1)
      const status = JSON.stringify(await f.controller.status())
      assert.ok(!status.includes(result.attemptId) && !status.includes('SYNTHETIC'))
      assert.throws(() => f.controller.view(f.controller.epoch, randomUUID()), /attempt-missing/)
      const view = f.controller.view(f.controller.epoch, result.attemptId)
      assert.equal(view.state, 'waiting')
      f.controller.answer(f.controller.epoch, result.attemptId, view.prompt!.id, 'SYNTHETIC_ANSWER')
      assert.throws(() => f.controller.answer(f.controller.epoch, result.attemptId, view.prompt!.id, 'SYNTHETIC_ANSWER'), /prompt-expired/)
      await setImmediate()
      assert.equal(f.controller.view(f.controller.epoch, result.attemptId).state, 'authorized')
      assert.equal((await f.controller.status()).credential, 'grant')
      assert.ok(!JSON.stringify(f.controller.view(f.controller.epoch, result.attemptId)).includes('SYNTHETIC'))
    } finally { await f.dispose() }
  })

  it('rechecks effective configuration at begin and permits sign-out after route deletion', async () => {
    const f = fixture()
    try {
      assert.equal((await f.controller.status()).environment, 'ready')
      f.configure(false)
      await assert.rejects(f.begin(), /route-missing/)
      f.setRecord({ kind: 'grant', payload: { token: 'SYNTHETIC_TOKEN' } })
      await f.controller.once(f.controller.epoch, f.requestId(), 'sign-out')
      assert.equal((await f.controller.status()).credential, 'absent')
      f.configure(true)
      for (const profile of [{ apiKeyEnv: 'MY_KEY' }, { baseURL: 'https://example.org' }, { headers: { Authorization: 'SYNTHETIC_TOKEN' } }]) {
        f.profile(profile)
        assert.equal((await f.controller.status()).environment, 'configuration-unsupported')
        await assert.rejects(f.begin(), /configuration-unsupported/)
      }
      assert.equal(f.calls, 0)
    } finally { await f.dispose() }
  })

  it('keeps an existing grant on reauthorization failure and sanitizes native errors', async () => {
    const f = fixture(async () => { throw new Error('SYNTHETIC_TOKEN https://secret.invalid/?code=SYNTHETIC_CODE') })
    try {
      f.setRecord({ kind: 'grant', payload: 'SYNTHETIC_OLD_TOKEN' })
      const id = await f.begin()
      await setImmediate()
      assert.equal(f.controller.view(f.controller.epoch, id).state, 'failed')
      assert.equal((await f.controller.status()).credential, 'grant')
      assert.ok(!JSON.stringify(f.controller.view(f.controller.epoch, id)).includes('SYNTHETIC'))
      assert.equal(f.deletes, 0)
    } finally { await f.dispose() }
  })

  it('rejects stale or invalid select answers and withdraws only the losing prompt', async () => {
    const withdraw = new AbortController()
    const f = fixture(async session => {
      await assert.rejects(session.prompt({ kind: 'text', message: 'loser', signal: withdraw.signal }), /prompt withdrawn/)
      const value = await session.prompt({ kind: 'select', message: 'method', options: [{ id: 'browser', label: 'Browser' }] })
      assert.equal(value, 'browser')
      await session.commit({ kind: 'grant', payload: {} })
    })
    try {
      const id = await f.begin()
      const first = f.controller.view(f.controller.epoch, id).prompt!
      withdraw.abort()
      await setImmediate()
      const second = f.controller.view(f.controller.epoch, id).prompt!
      assert.notEqual(first.id, second.id)
      assert.throws(() => f.controller.answer(f.controller.epoch, id, first.id, 'x'), /prompt-expired/)
      assert.throws(() => f.controller.answer(f.controller.epoch, id, second.id, 'bad'), /invalid-answer/)
      f.controller.answer(f.controller.epoch, id, second.id, 'browser')
      await setImmediate()
      assert.equal(f.controller.view(f.controller.epoch, id).state, 'authorized')
    } finally { await f.dispose() }
  })

  it('excludes other begins, cancels and times out without deleting grants', async () => {
    const f = fixture(undefined, 20)
    try {
      f.setRecord({ kind: 'grant', payload: {} })
      const id = await f.begin()
      await assert.rejects(f.begin(), /busy/)
      await setTimeout(35)
      assert.equal(f.controller.view(f.controller.epoch, id).state, 'cancelled')
      assert.equal((await f.controller.status()).credential, 'grant')
      const next = await f.begin()
      await f.controller.cancel(f.controller.epoch, next)
      assert.equal(f.controller.view(f.controller.epoch, next).state, 'cancelled')
      assert.equal(f.deletes, 0)
    } finally { await f.dispose() }
  })

  it('deduplicates sign-out, rejects old Host requests, and reports storage failure', async () => {
    const f = fixture()
    try {
      const requestId = f.requestId()
      await f.controller.once(f.controller.epoch, requestId, 'sign-out')
      f.setRecord({ kind: 'grant', payload: {} })
      await f.controller.once(f.controller.epoch, requestId, 'sign-out')
      assert.equal(f.deletes, 1)
      assert.equal((await f.controller.status()).credential, 'grant')
      assert.throws(() => f.controller.once(randomUUID(), f.requestId(), 'sign-out'), /stale-host/)
      assert.throws(() => f.controller.once(f.controller.epoch, `${Date.now() - 1_000_000}-${randomUUID()}`, 'sign-out'), /expired-request/)
      f.readOnly()
      const response = await f.post('sign-out', { epoch: f.controller.epoch, requestId: f.requestId() })
      assert.equal(response.status, 500)
      assert.ok(!(await response.text()).includes('SYNTHETIC'))
      assert.equal((await f.controller.status()).credential, 'grant')
    } finally { await f.dispose() }
  })

  it('validates the exact API body and replays a current SSE baseline without old prompts', async () => {
    const f = fixture()
    try {
      const response = await f.post('begin', { epoch: f.controller.epoch, requestId: f.requestId(), key: 'other/key' })
      assert.equal(response.status, 400)
      assert.equal(f.calls, 0)
      const id = await f.begin()
      const events = f.routes.get('/api/codex-login/events')!
      const open = () => events.fetch(new Request(`http://localhost/api/codex-login/events?epoch=${f.controller.epoch}&attemptId=${id}`))
      const stream = await open()
      assert.equal(stream.headers.get('cache-control'), 'no-store, no-transform')
      const reader = stream.body!.getReader()
      const baseline = new TextDecoder().decode((await reader.read()).value)
      assert.ok(baseline.includes('SYNTHETIC_CODE_PROMPT'))
      await reader.cancel()
      await f.controller.cancel(f.controller.epoch, id)
      const reconnect = (await open()).body!.getReader()
      const terminal = new TextDecoder().decode((await reconnect.read()).value)
      assert.ok(terminal.includes('cancelled') && !terminal.includes('SYNTHETIC'))
      await reconnect.cancel()
      assert.equal(safeUrl('javascript:alert(1)'), undefined)
      assert.equal(safeUrl('https://user:pass@example.org'), undefined)
      assert.equal(safeUrl('https://example.org/authorize'), 'https://example.org/authorize')
    } finally { await f.dispose() }
  })

  it('keeps notice and secret prompts private and clears streams on unload', async () => {
    const f = fixture(async session => {
      session.notify({ message: 'SYNTHETIC_NOTICE', url: 'javascript:alert(1)', code: 'SYNTHETIC_DEVICE_CODE' })
      await session.prompt({ kind: 'secret', message: 'SYNTHETIC_SECRET_PROMPT' })
    })
    const id = await f.begin()
    const view = f.controller.view(f.controller.epoch, id)
    assert.equal(view.prompt?.kind, 'secret')
    assert.equal(view.notice?.url, undefined)
    assert.equal(view.notice?.code, 'SYNTHETIC_DEVICE_CODE')
    const stream = await f.routes.get('/api/codex-login/events')!.fetch(new Request(`http://localhost/api?epoch=${f.controller.epoch}`))
    const reader = stream.body!.getReader()
    const frame = new TextDecoder().decode((await reader.read()).value)
    assert.ok(!frame.includes(id) && !frame.includes('SYNTHETIC'))
    await f.dispose()
    // dispose() may enqueue one final public invalidation before closing.
    while (!(await reader.read()).done) { /* drain the bounded public stream */ }
    assert.equal(f.routes.size, 0)
  })

  it('does not cancel or delete a record owned by an external authorization attempt', async () => {
    const f = fixture()
    const external = new AbortController()
    const done = f.auth.begin({ key: KEY, signal: external.signal, interaction: {
      notify() {},
      prompt: () => new Promise((_resolve, reject) => external.signal.addEventListener('abort', () => reject(new Error('external cancel')), { once: true })),
    } })
    try {
      await assert.rejects(f.controller.once(f.controller.epoch, f.requestId(), 'sign-out'), /busy/)
      assert.equal(f.auth.describe(KEY)?.inFlight, true)
      assert.equal(f.deletes, 0)
    } finally {
      external.abort()
      await done
      await f.dispose()
    }
  })
})
