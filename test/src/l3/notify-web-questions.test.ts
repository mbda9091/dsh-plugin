import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { apply as applyAskUser } from '@deepseek-ai/dsh-tool-ask-user'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createQuestionSource, questionProjection } from '@mbda9091/notify-web'
import { createFakeContext } from '../harness/fake-context.js'

/** Real Session log and real projection registry; only the live-agent catalogue is a test double. */
async function setup(session = Session.create(SessionId('root'))) {
  const registry = new SessionProjectionRegistry(new Context())
  const root = { session }
  const roots = [root]
  const fake = createFakeContext({ agents: { roots: () => roots }, sessionProjections: registry })
  const source = await createQuestionSource(fake as unknown as Context)
  const updates: Array<{ type: string; kind: string; id: string }> = []
  source.subscribe(update => updates.push(update))
  const commit = (event: SessionEvent): void => { fake.emit('session/event', session, event) }
  const ask = (id = 'call', args = JSON.stringify({ questions: [{ id: 'q', question: '  Which\n option? ' }] })) => {
    commit(session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name: 'ask_user_question', arguments: args }))
  }
  const result = (text: string, code?: string, id = 'call') => {
    commit(session.append('tool/result', { turn: 1, step: 1, message: {
      id: MessageId(randomUUID()), role: 'tool', source: { kind: 'tool', callId: ToolCallId(id) }, toolCallId: ToolCallId(id), content: [{ type: 'text', text }],
      ...(code ? { isError: true } : {}),
    }, ...(code ? { error: { name: 'Error', code } } : {}) }, { surfaceOp: 'append' }))
  }
  const timed = () => commit(session.append('request/header', { reason: 'initial', header: {
    config: { provider: 'fixture', model: 'fixture' }, tools: [{ name: 'ask_user_question', description: '', parameters: { type: 'object', properties: { timeout: { type: 'number' } } } }],
  } }))
  return { session, roots, fake, source, updates, commit, ask, result, timed }
}

it('L3 question: blocking call emits one bounded batch, then withdraws on answer', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  f.ask('call', JSON.stringify({ questions: [{ id: 'q', question: ' Which\n option? ' }, { id: 'q2', question: 'Other?' }] }))
  assert.equal(f.updates.length, 1)
  assert.equal(f.source.snapshot()[0]?.question, 'Which option?')
  assert.equal(f.source.snapshot().length, 1)
  assert.equal(f.updates.length, 1, 'reading snapshots does not show twice')
  f.result('{"answers":[]}')
  assert.deepEqual(f.updates.map(item => item.type), ['show', 'withdraw'])
  assert.deepEqual(f.source.snapshot(), [])
})

it('L3 question: timed pending survives completion until an admitted late reply', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  f.timed(); f.ask(); f.result('{"pending":true}')
  f.commit(f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  // A queued reply is not an admitted user message.
  f.commit(f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] }))
  assert.equal(f.source.snapshot().length, 1)
  assert.equal(f.updates.length, 1)
  f.commit(f.session.append('user/message', { id: MessageId(randomUUID()), role: 'user',
    source: { kind: 'user-question-reply', callId: ToolCallId('call'), outcome: 'answered' },
    content: [{ type: 'text', text: '{"answers":[]}' }] }, { surfaceOp: 'append' }))
  assert.deepEqual(f.updates.map(item => item.type), ['show', 'withdraw'])
})

it('L3 question: the original DSH timed tool and service return pending without withdrawing', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  const ctx = new Context()
  const agent = { id: f.session.id, session: f.session }
  ctx.provide('agents', { get: () => agent, roots: () => [agent] })
  new UserQuestionService(ctx)
  let definition: ToolDefinition | undefined
  ctx.provide('tools', { register(tool: ToolDefinition) { definition = tool; return () => {} } })
  applyAskUser(ctx, { mode: 'timed', timeout: 1 })
  const tool = definition!
  assert.ok(tool)
  const off = ctx.on('user-questions/request', async request => {
    return new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
    })
  }, { global: true })
  t.after(off)
  f.commit(f.session.append('request/header', { reason: 'initial', header: {
    config: { provider: 'fixture', model: 'fixture' },
    tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
  } }))
  const args = { questions: [{ id: 'q', question: 'Which option?' }], timeout: 1 }
  f.ask('call', JSON.stringify(args))
  // The original body needs these execution fields; registry/ownership is controlled here.
  const execution = { agent, callId: ToolCallId('call'), signal: new AbortController().signal } as unknown as ToolRunContext
  const keepAlive = setTimeout(() => {}, 2000)
  t.after(() => clearTimeout(keepAlive))
  const value = await tool.execute(args, execution)
  assert.equal((value as { pending?: boolean }).pending, true)
  f.result(JSON.stringify(value))
  assert.equal(f.source.snapshot().length, 1)
  assert.deepEqual(f.updates.map(item => item.type), ['show'])
})

it('L3 question: failures withdraw, and only timed unknown outcomes remain answerable', async t => {
  for (const timed of [false, true]) {
    const f = await setup(); t.after(() => f.source.dispose())
    if (timed) f.timed()
    f.ask(); f.result('unknown', 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(f.source.snapshot().length, timed ? 1 : 0)
    if (timed) f.result('aborted', 'ASK_ABORTED')
    assert.deepEqual(f.source.snapshot(), [])
  }
})

it('L3 question: malformed arguments are ignored; empty summaries are allowed', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  for (const args of ['broken', '{}', '{"questions":[]}', '{"questions":[{"id":"q"}]}']) f.ask(randomUUID(), args)
  assert.deepEqual(f.updates, [])
  f.ask('empty', '{"questions":[{"id":"q","question":"  "}]}')
  assert.equal(f.source.snapshot()[0]?.question, '')
})

it('L3 question: pending PTC dispatch is reconstructable and uses the subcall identity', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  const data = { rootCallId: ToolCallId('parent'), parentCallId: ToolCallId('parent'), subCallId: ToolCallId('parent:ptc:1'),
    name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: 'PTC question?' }] },
    isError: false, content: [{ type: 'text' as const, text: '{"pending":true}' }] }
  f.commit(f.session.append('tool/ptc-dispatch', data))
  assert.equal(f.source.snapshot()[0]?.id, 'root:question:parent:ptc:1')
  f.commit(f.session.append('tool/ptc-dispatch', { ...data, isError: true, subCallId: ToolCallId('failed') }))
  assert.equal(f.source.snapshot().length, 1)
})

it('L3 question: PTC blocking calls notify at dispatch start and withdraw after an answer or error', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  const data = { rootCallId: ToolCallId('parent'), parentCallId: ToolCallId('parent'), subCallId: ToolCallId('parent:ptc:1'),
    name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: 'PTC waiting?' }] } }
  f.commit(f.session.append('tool/ptc-dispatch-start', data))
  assert.equal(f.source.snapshot()[0]?.id, 'root:question:parent:ptc:1', 'must notify while the user is still being asked')
  f.commit(f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '{"answers":[]}' }] }))
  assert.deepEqual(f.source.snapshot(), [])
  const second = { ...data, subCallId: ToolCallId('parent:ptc:2') }
  f.commit(f.session.append('tool/ptc-dispatch-start', second))
  f.commit(f.session.append('tool/ptc-dispatch', { ...second, isError: true, content: [{ type: 'text', text: 'aborted' }] }))
  assert.deepEqual(f.source.snapshot(), [])
  assert.deepEqual(f.updates.map(item => item.type), ['show', 'withdraw', 'show', 'withdraw'])
})

it('L3 question: PTC pending keeps the start identity and survives the parent result', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  const data = { rootCallId: ToolCallId('parent'), parentCallId: ToolCallId('parent'), subCallId: ToolCallId('parent:ptc:1'),
    name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: 'Timed PTC?' }] } }
  f.commit(f.session.append('tool/ptc-dispatch-start', data))
  const original = f.source.snapshot()[0]
  f.commit(f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '{"pending":true}' }] }))
  f.result('{}', undefined, 'parent')
  assert.deepEqual(f.source.snapshot()[0], original)
  assert.equal(f.updates.length, 1)
  f.commit(f.session.append('user/message', { id: MessageId(randomUUID()), role: 'user',
    source: { kind: 'user-question-reply', callId: data.subCallId, outcome: 'answered' },
    content: [{ type: 'text', text: '{"answers":[]}' }] }, { surfaceOp: 'append' }))
  assert.deepEqual(f.updates.map(item => item.type), ['show', 'withdraw'])
})

it('L3 question: an interrupted parent closes PTC calls without a recorded subcall outcome', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  f.commit(f.session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('parent'), parentCallId: ToolCallId('parent'),
    subCallId: ToolCallId('parent:ptc:1'), name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: 'Interrupted?' }] } }))
  assert.equal(f.source.snapshot().length, 1)
  f.result('unknown', 'TOOL_OUTCOME_UNKNOWN', 'parent')
  assert.deepEqual(f.source.snapshot(), [])
})

it('L3 question: root disposal withdraws and recreation restores pending log state', async t => {
  const f = await setup(); t.after(() => f.source.dispose())
  f.ask()
  const root = f.roots.pop()!
  f.fake.emit('agent/disposed', { agent: root })
  assert.deepEqual(f.source.snapshot(), [])
  f.roots.push(root)
  await f.fake.emitAsync('agent/created', { agent: root })
  assert.deepEqual(f.updates.map(item => item.type), ['show', 'withdraw', 'show'])
  await f.source.dispose()
  f.ask('after-dispose')
  assert.equal(f.fake.listeners.length, 0)
  assert.deepEqual(f.source.snapshot(), [])
})

it('L3 question: nonroots stay silent and existing root history restores without live events', async t => {
  const session = Session.create(SessionId('restored'))
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('old'), name: 'ask_user_question',
    arguments: '{"questions":[{"id":"q","question":"Restored?"}]}' })
  const f = await setup(session); t.after(() => f.source.dispose())
  assert.equal(f.source.snapshot().length, 1)
  f.roots.splice(0)
  f.ask('sub')
  assert.deepEqual(f.source.snapshot(), [])
  assert.equal(f.updates.filter(item => item.type === 'show').length, 1)
})

it('L3 question: inherited prefix never creates a child reminder', async t => {
  const parent = Session.create(SessionId('parent'))
  const call = parent.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('inherited'), name: 'ask_user_question',
    arguments: '{"questions":[{"id":"q","question":"Parent question"}]}' })
  const state = questionProjection.init(parent.header, SessionLogOffset(1))
  assert.equal(questionProjection.apply(state, call), state)
  const f = await setup(); t.after(() => f.source.dispose())
  f.ask()
  assert.equal(f.source.snapshot().length, 1, 'own calls still notify')
})
