import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createNotificationSource } from '@local/notify-host'
import type { NotificationUpdate, TriggerOptions } from '@local/notify-host'

const OPTIONS: TriggerOptions = {
  notifyOnQuestion: true,
  notifyOnApproval: true,
  approvalDelayMs: 10,
  notifyOnTurnEnd: true,
  notifyOnTurnError: true,
}

const ROOT = { id: 'root' }
const SUB = { id: 'sub' }

interface FakeAgent {
  readonly session: { readonly id: string }
}

function createContext(agents?: { list(): FakeAgent[]; roots(): FakeAgent[] }): {
  ctx: Context
  emit(event: string, ...args: unknown[]): void
  listeners: Array<{ event: string; handler: (...args: unknown[]) => unknown }>
} {
  const listeners: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = []
  const ctx = {
    get: (name: string) => name === 'agents' ? agents : undefined,
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((item) => item.event === event && item.handler === handler)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
  }
  return {
    ctx: ctx as unknown as Context,
    emit(event, ...args) {
      for (const listener of listeners.filter((item) => item.event === event)) listener.handler(...args)
    },
    listeners,
  }
}

function agentsWith(roots: string[], subs: string[]): { list(): FakeAgent[]; roots(): FakeAgent[] } {
  const rootAgents = roots.map((id) => ({ session: { id } }))
  const subAgents = subs.map((id) => ({ session: { id } }))
  return {
    list: () => [...rootAgents, ...subAgents],
    roots: () => rootAgents,
  }
}

function approvalAsked(id: string, toolName = 'pwsh', reason?: string, seq = 1): unknown {
  return {
    type: 'approval/asked',
    seq,
    time: 1_000,
    data: { id, toolName, ...reason === undefined ? {} : { reason } },
  }
}

function approvalDecided(id: string, seq = 2): unknown {
  return { type: 'approval/decided', seq, time: 1_001, data: { id, outcome: 'rejected' } }
}

function turnEnd(reason: unknown, seq = 3): unknown {
  return { type: 'turn/end', seq, time: 1_002, data: { turn: 1, reason } }
}

function collect(): { updates: NotificationUpdate[]; listener: (update: NotificationUpdate) => void } {
  const updates: NotificationUpdate[] = []
  return {
    updates,
    listener: (update) => {
      updates.push(update)
    },
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('L3 notify-host: approval source', () => {
  it('delays a root approval and emits one show update', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, approvalAsked('a1', 'pwsh', '  need\n access  '))
    assert.deepEqual(updates, [])
    await delay(20)
    assert.deepEqual(updates, [{
      type: 'show',
      kind: 'approval',
      id: 'root:approval:a1',
      sessionId: 'root',
      seq: 1,
      at: 1_000,
      toolName: 'pwsh',
      reason: 'need access',
    }])
    assert.equal(source.snapshotPending().length, 1)
    source.dispose()
  })

  it('cancels a pending approval when it is decided first', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, approvalAsked('a1'))
    fake.emit('session/event', ROOT, approvalDecided('a1'))
    await delay(20)
    assert.deepEqual(updates, [])
    assert.deepEqual(source.snapshotPending(), [])
    source.dispose()
  })

  it('withdraws an approval after it has been shown', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, approvalAsked('a1'))
    await delay(20)
    fake.emit('session/event', ROOT, approvalDecided('a1', 5))
    assert.equal(updates.at(-1)?.type, 'withdraw')
    assert.equal(updates.at(-1)?.seq, 5)
    assert.deepEqual(source.snapshotPending(), [])
    source.dispose()
  })

  it('does not emit a second update for a repeated asked id', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, approvalAsked('a1', 'pwsh', 'first'))
    fake.emit('session/event', ROOT, approvalAsked('a1', 'pwsh', 'second'))
    await delay(20)
    assert.equal(updates.filter((update) => update.type === 'show').length, 1)
    const first = updates[0]
    assert.ok(first?.type === 'show' && first.kind === 'approval')
    assert.equal(first.reason, 'first')
    source.dispose()
  })

  it('ignores subagents and unknown root identity', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', SUB, approvalAsked('a1'))
    await delay(20)
    assert.deepEqual(updates, [])

    const unknown = createContext()
    const unknownSource = createNotificationSource(unknown.ctx, OPTIONS)
    const second = collect()
    unknownSource.subscribe(second.listener)
    unknown.emit('session/event', ROOT, approvalAsked('a2'))
    await delay(20)
    assert.deepEqual(second.updates, [])
    source.dispose()
    unknownSource.dispose()
  })

  it('cleans pending and shown approvals when the Agent is disposed', async () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, approvalAsked('pending', 'pwsh', 'x'))
    fake.emit('session/event', ROOT, approvalAsked('shown', 'pwsh', 'y'))
    await delay(20)
    fake.emit('agent/disposed', { agent: { session: { id: 'root' } } })
    assert.equal(updates.at(-1)?.type, 'withdraw')
    assert.deepEqual(source.snapshotPending(), [])
    source.dispose()
  })
})

describe('L3 notify-host: turn endings', () => {
  it('emits completion, max-tokens, and error intents', () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, turnEnd({ kind: 'completed' }, 1))
    fake.emit('session/event', ROOT, turnEnd({ kind: 'max-tokens' }, 2))
    fake.emit('session/event', ROOT, turnEnd({ kind: 'error', error: { message: '  boom\n happened  ' } }, 3))
    assert.deepEqual(updates.map((update) => update.type === 'show' ? update.kind : update.type), ['turn-end', 'turn-end', 'turn-end'])
    const error = updates[2]
    assert.ok(error?.type === 'show' && error.kind === 'turn-end')
    assert.equal(error.reasonKind, 'error')
    assert.equal(error.errorMessage, 'boom happened')
    source.dispose()
  })

  it('stays silent for aborted/blocked/interrupted/forked and subagents', () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS)
    const { updates, listener } = collect()
    source.subscribe(listener)
    for (const kind of ['aborted', 'blocked', 'interrupted', 'forked']) {
      fake.emit('session/event', ROOT, turnEnd({ kind }, 1))
    }
    fake.emit('session/event', SUB, turnEnd({ kind: 'completed' }, 2))
    assert.deepEqual(updates, [])
    source.dispose()
  })

  it('honours the completion and error switches', () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, { ...OPTIONS, notifyOnTurnEnd: false, notifyOnTurnError: false })
    const { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, turnEnd({ kind: 'completed' }))
    fake.emit('session/event', ROOT, turnEnd({ kind: 'error', error: { message: 'x' } }))
    assert.deepEqual(updates, [])
    source.dispose()
  })
})

describe('L3 notify-host: question cards', () => {
  const call = (id = 'q1') => ({ type: 'tool/call', seq: 10, time: 1000,
    data: { callId: id, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'choice', question: '  Which\noption? ' }] }) } })
  const result = (content: object, isError = false) => ({ type: 'tool/result', seq: 11, time: 1001,
    data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: JSON.stringify(content) }], isError } } })
  it('notifies root calls once, retains timed cards, and withdraws a late answer', () => {
    const fake = createContext(agentsWith(['root'], ['sub']))
    const source = createNotificationSource(fake.ctx, OPTIONS), { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', SUB, call())
    fake.emit('session/event', ROOT, call())
    fake.emit('session/event', ROOT, call())
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0], { type: 'show', kind: 'question', id: 'root:question:q1', sessionId: 'root', seq: 10, at: 1000, question: 'Which option?' })
    fake.emit('session/event', ROOT, result({ pending: true }))
    assert.equal(source.snapshotPending().length, 1)
    fake.emit('session/event', ROOT, { type: 'user/message', seq: 12, time: 1002, data: { source: { kind: 'user-question-reply', callId: 'q1', outcome: 'answered' } } })
    assert.equal(source.snapshotPending().length, 0)
    assert.equal(updates.at(-1)?.type, 'withdraw')
    source.dispose()
  })
  it('withdraws completed, failed and cancelled calls and honors the switch', () => {
    for (const isError of [false, true]) {
      const fake = createContext(agentsWith(['root'], []))
      const source = createNotificationSource(fake.ctx, OPTIONS), { updates, listener } = collect()
      source.subscribe(listener)
      fake.emit('session/event', ROOT, call())
      fake.emit('session/event', ROOT, result({ answers: [] }, isError))
      assert.equal(source.snapshotPending().length, 0)
      assert.equal(updates.at(-1)?.type, 'withdraw')
      source.dispose()
    }
    const fake = createContext(agentsWith(['root'], []))
    const source = createNotificationSource(fake.ctx, { ...OPTIONS, notifyOnQuestion: false })
    fake.emit('session/event', ROOT, call())
    assert.deepEqual(source.snapshotPending(), [])
    source.dispose()
  })
  it('keeps unknown repaired outcomes and cleans cards when the agent is disposed', () => {
    const fake = createContext(agentsWith(['root'], []))
    const source = createNotificationSource(fake.ctx, OPTIONS), { updates, listener } = collect()
    source.subscribe(listener)
    fake.emit('session/event', ROOT, call())
    fake.emit('session/event', ROOT, { type: 'tool/result', seq: 11, time: 1001, data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' }, message: { toolCallId: 'q1', content: [] } } })
    assert.equal(source.snapshotPending().length, 1)
    fake.emit('agent/disposed', { agent: { session: ROOT } })
    assert.equal(source.snapshotPending().length, 0)
    assert.equal(updates.at(-1)?.type, 'withdraw')
    source.dispose()
  })
  it('tracks a continued programmatic sub-call without duplicating it', () => {
    const fake = createContext(agentsWith(['root'], []))
    const source = createNotificationSource(fake.ctx, OPTIONS), { updates, listener } = collect()
    source.subscribe(listener)
    const event = { type: 'tool/ptc-dispatch', seq: 10, time: 1000, data: { name: 'ask_user_question', subCallId: 'q1', arguments: { questions: [{ id: 'choice', question: 'Which option?' }] }, content: [{ type: 'text', text: '{"pending":true}' }], isError: false } }
    fake.emit('session/event', ROOT, event)
    fake.emit('session/event', ROOT, event)
    assert.equal(updates.length, 1)
    assert.equal(source.snapshotPending()[0]?.kind, 'question')
    source.dispose()
  })
})
