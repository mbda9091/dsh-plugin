import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { GoalPhase } from '@deepseek-ai/dsh-goal'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createNotificationSource } from '@mbda9091/notify-host'
import type { NotificationUpdate } from '@mbda9091/notify-host'
import { createFakeContext } from "../../../common/harness/fake-context.js"

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const root = {
    session: Session.create(SessionId('completion-root')),
    status: 'idle' as 'idle' | 'running',
    inbox: { nextTurn: [] as string[], nextStep: [] as string[] },
    whenIdle: async (): Promise<void> => {},
  }
  let live = root
  let phase: GoalPhase | undefined
  let activation = 'armed'
  let join = async (): Promise<boolean> => false
  let joins = 0
  const registry = { get: () => live, list: () => [live] }
  const goals = { get: () => phase === undefined ? undefined : { phase, activation } }
  const subagents = { rootOf: () => live, waitForTreeWork: () => { joins++; return join() } }
  const ctx = createFakeContext({ agents: registry, goals, subagents })
  const source = createNotificationSource(ctx as unknown as Context, {
    notifyOnApproval: true, approvalDelayMs: 0, notifyOnTurnEnd: true, notifyOnTurnError: true,
  }, 'settled')
  const updates: NotificationUpdate[] = []
  source.subscribe(update => updates.push(update))
  let seq = 0
  const event = (type: string, data: unknown = {}) => ctx.emit('session/event', root.session, { type, seq: ++seq, time: seq, data })
  const end = (kind = 'completed') => event('turn/end', { turn: seq, reason: { kind, error: { message: 'failed' } } })
  return {
    ctx, root, source, updates, event, end,
    setPhase(value: GoalPhase | undefined, armed = 'armed') { phase = value; activation = armed },
    setJoin(value: () => Promise<boolean>) { join = value },
    replace() { live = { ...root } },
    get joins() { return joins },
  }
}

describe('L3 notify-host: settled Web completion', () => {
  it('waits for root activity to retire, then emits once with the source event identity', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const idle = deferred<void>()
    h.root.status = 'running'
    h.root.whenIdle = () => idle.promise
    h.end()
    assert.equal(h.updates.length, 0)
    await setImmediate()
    assert.equal(h.joins, 0)
    h.root.status = 'idle'; idle.resolve()
    await setImmediate()
    assert.deepEqual(h.updates, [{
      type: 'show', kind: 'turn-end', id: 'completion-root:turn-end:1', sessionId: 'completion-root',
      seq: 1, at: 1, reasonKind: 'completed',
    }])
  })

  for (const phase of ['active', 'paused', 'blocked'] as const) {
    for (const activation of ['armed', 'disarmed']) {
      it(`does not claim success while goal=${phase}, activation=${activation}`, async t => {
        const h = setup(); t.after(() => h.source.dispose())
        h.setPhase(phase, activation); h.end()
        await setImmediate()
        assert.equal(h.updates.length, 0)
        assert.equal(h.joins, 0, 'active goals must not allocate child waiters')
      })
    }
  }

  it('ignores intermediate goal rounds and waits for the final reply after the complete tool', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    h.setPhase('active')
    for (let n = 0; n < 3; n++) { h.event('turn/start'); h.end(); await setImmediate() }
    assert.equal(h.updates.length, 0)
    h.setPhase('complete'); h.event('goal/change')
    await setImmediate()
    assert.deepEqual(h.updates, [], 'complete tool alone must not emit a notification')
    h.end(); await setImmediate()
    assert.equal(h.updates.length, 1)
    h.event('turn/start'); h.end(); await setImmediate()
    assert.equal(h.updates.length, 2, 'a retained completed goal must not suppress later user turns')
  })

  it('never sends the waiting turn after children settle; only the root summary notifies', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>()
    h.setJoin(() => children.promise)
    h.end(); await setImmediate()
    assert.equal(h.joins, 1)
    assert.equal(h.updates.length, 0)
    children.resolve(true); await setImmediate()
    assert.equal(h.updates.length, 0)
    h.event('turn/start'); h.setJoin(async () => false); h.end(); await setImmediate()
    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0]?.seq, 3)
  })

  for (const type of ['turn/start', 'user/message', 'goal/change']) {
    it(`invalidates the old turn on ${type} during root retirement`, async t => {
      const h = setup(); t.after(() => h.source.dispose())
      const idle = deferred<void>(); h.root.whenIdle = () => idle.promise
      h.end(); h.event(type); idle.resolve(); await setImmediate()
      assert.equal(h.updates.length, 0)
    })
  }

  it('invalidates waiting completions as soon as a new input is queued', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>(); h.setJoin(() => children.promise)
    h.end(); await setImmediate()
    h.ctx.emit('agent/inbox/inserted', { agent: h.root })
    children.resolve(false); await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  it('shares a runtime child wait across invalidated root turns without duplicating joins', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>(); h.setJoin(() => children.promise)
    const reactions = t.mock.method(children.promise, 'then')
    for (let n = 0; n < 10; n++) {
      h.event('turn/start'); h.end(); await setImmediate()
    }
    assert.equal(h.joins, 1)
    assert.equal(reactions.mock.callCount(), 1, 'old turns must not accumulate Promise reactions')
    children.resolve(true); await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  it('does not accumulate root-idle reactions across queued turns in one activity', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const idle = deferred<void>(); h.root.whenIdle = () => idle.promise
    const reactions = t.mock.method(idle.promise, 'then')
    for (let n = 0; n < 10; n++) { h.event('turn/start'); h.end(); await setImmediate() }
    assert.equal(reactions.mock.callCount(), 1)
    h.source.dispose(); idle.resolve(); await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  it('uses the replacement subagent provider instead of the previous provider\'s pending work', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>(); h.setJoin(() => children.promise)
    h.end(); await setImmediate()
    let newJoins = 0
    h.ctx.services.set('subagents', { rootOf: () => h.root, waitForTreeWork: async () => { newJoins++; return false } })
    h.event('turn/start'); h.end(); await setImmediate()
    assert.equal(newJoins, 1)
    assert.equal(h.updates.length, 1)
    children.resolve(true); await setImmediate()
    assert.equal(h.updates.length, 1)
  })

  for (const boundary of ['nextStep', 'nextTurn'] as const) {
    it(`does not notify with pending ${boundary} input`, async t => {
      const h = setup(); t.after(() => h.source.dispose())
      h.root.inbox[boundary].push('message'); h.end(); await setImmediate()
      assert.equal(h.updates.length, 0)
    })
  }

  it('rejects stale Agent identity and same-id Session objects', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const idle = deferred<void>(); h.root.whenIdle = () => idle.promise
    h.end(); h.replace(); idle.resolve(); await setImmediate()
    assert.equal(h.updates.length, 0)
    h.ctx.emit('session/event', { id: h.root.session.id }, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
    await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  for (const service of ['goals', 'subagents']) {
    it(`suppresses an in-flight check if ${service} disappears`, async t => {
      const h = setup(); t.after(() => h.source.dispose())
      const children = deferred<boolean>(); h.setJoin(() => children.promise)
      h.end(); await setImmediate(); h.ctx.services.delete(service)
      children.resolve(false); await setImmediate()
      assert.equal(h.updates.length, 0)
    })
  }

  it('works in a composition without goal or subagent services', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    h.ctx.services.delete('goals'); h.ctx.services.delete('subagents')
    h.end(); await setImmediate()
    assert.equal(h.updates.length, 1)
  })

  it('compares service providers rather than freshly traced Cordis proxies', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    t.mock.method(h.ctx, 'get', (name: string) => {
      const service = h.ctx.services.get(name)
      if ((name !== 'goals' && name !== 'subagents') || service === undefined) return service
      const target = service as object
      return new Proxy(target, { get: (object, key) => key === Symbol.for('cordis.original') ? object : Reflect.get(object, key) })
    })
    h.end(); await setImmediate()
    assert.equal(h.updates.length, 1)
  })

  it('contains goal and child inspection failures without reporting success', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const warnings: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
    h.ctx.services.set('goals', { get() { throw new Error('projection unavailable') } })
    h.end(); await setImmediate()
    h.ctx.services.delete('goals')
    h.setJoin(async () => { throw new Error('join unavailable') })
    h.end(); await setImmediate()
    assert.equal(h.updates.length, 0)
    assert.equal(warnings.length, 2)
  })

  it('disposes listeners and ignores a later child-wait rejection', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>(); h.setJoin(() => children.promise)
    h.end(); await setImmediate()
    h.source.dispose(); h.source.dispose()
    assert.equal(h.ctx.listeners.length, 0)
    children.reject(new Error('work ended after unload')); await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  it('agent disposal cancels a pending success but retains the live source listeners', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const children = deferred<boolean>(); h.setJoin(() => children.promise)
    h.end(); await setImmediate()
    h.ctx.emit('agent/disposed', { agent: h.root })
    children.resolve(false); await setImmediate()
    assert.equal(h.updates.length, 0)
  })

  it('deduplicates a repeated completion event without cancelling its first check', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    const event = { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }
    h.ctx.emit('session/event', h.root.session, event)
    h.ctx.emit('session/event', h.root.session, event)
    await setImmediate()
    h.ctx.emit('session/event', h.root.session, event); await setImmediate()
    assert.equal(h.updates.length, 1)
  })

  it('preserves output-limit and error reminders while a goal is active', async t => {
    const h = setup(); t.after(() => h.source.dispose())
    h.setPhase('active'); h.end('max-tokens'); h.end('error')
    assert.deepEqual(h.updates.map(update => update.type === 'show' && update.kind === 'turn-end' && update.reasonKind), ['max-tokens', 'error'])
  })
})
