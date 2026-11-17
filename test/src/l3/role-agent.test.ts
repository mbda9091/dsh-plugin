import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionStore, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
// The SDK root omits this native producer augmentation; type-only fixture import.
import type {} from '../../../node_modules/@deepseek-ai/dsh-schedule/lib/types/runtime.js'
import { RoleEngine, Hindsight, initial, spec, digest, operationId, type MemoryBackend, type Episode, type ReflectionResult, type EnginePorts, type Source, proposalSchema, validateProposal } from '@mbda9091/role-agent'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'role-contract-'))
  const ctx = new Context(); const storage = new Storage(ctx); const backend = new JsonStorageBackend(root)
  storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  let domain = await facility.open(spec); let table = domain.table('characters')
  await table.put('lan', initial('lan', 'role-lan'))
  new SessionStore(ctx)
  const logs = new Map<string, SessionEvent[]>()
  const off = ctx.on('session/event', (s, event) => { const list = logs.get(s.id) ?? []; list.push(event); logs.set(s.id, list) }, { global: true })
  const retained: string[] = []; const removed: string[] = []; let reflectCount = 0
  const memory: MemoryBackend = { prepare: async () => {}, retain: async ep => { retained.push(ep.id) }, remove: async id => { removed.push(id) }, recall: async () => [] }
  const ports: EnginePorts = { backend: memory, read: async (id, offset, length) => (logs.get(id) ?? []).slice(offset, offset + length),
    reflect: async input => { reflectCount++; return { proposal: { updates: [] }, auditId: `audit-${input.job.id}` } }, route: ep => ep.route, error: () => {} }
  const make = () => new RoleEngine(table, { characterId: 'lan', batchTurns: 2, maxEvidenceChars: 24000, maxBeliefs: 24, maxHits: 5, maxResultChars: 8000, maxWorkPerDrain: 32, maxAttempts: 3 }, ports)
  let engine = make()
  const session = ctx.sessions.create(SessionId('contract-root'), { meta: { cwd: root } })
  await engine.bind(session.id)
  return { ctx, session, logs, ports, memory, retained, removed, get table() { return table }, get engine() { return engine }, get reflectCount() { return reflectCount },
    async reopen() { await engine.close(); await domain.close(); domain = await facility.open(spec); table = domain.table('characters'); engine = make() },
    async close() { await engine.close(); off(); await domain.close(); await backend.close(); await rm(root, { recursive: true, force: true }) },
  }
}
function turn(s: Session, n: number, user: string, answer = '我会先听你说，也想知道为什么。'): void {
  s.append('turn/start', { turn: n })
  s.append('step/start', { turn: n, step: 1 })
  s.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  s.append('request/header', { header: { config: { provider: 'contract', model: `model-${n}` } }, reason: n === 1 ? 'initial' : 'change' })
  s.append('assistant/message', { turn: n, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: answer }], source: { provider: 'contract', model: `model-${n}` } }), stream: [] }, { surfaceOp: 'append' })
  s.append('step/end', { turn: n, step: 1 }); s.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}
function toolTurn(s: Session, text: string): void {
  s.append('turn/start', { turn: 1 })
  s.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请读取这份长材料，保留来源。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  s.append('request/header', { header: { config: { provider: 'contract', model: 'long-source' } }, reason: 'initial' })
  s.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('read-long'), name: 'read', arguments: '{"path":"synthetic.txt"}' })
  s.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('read-long'), content: [{ type: 'text', text }], isError: false }) }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '我收到了材料；需要细节时按原始来源展开。' }], source: { provider: 'contract', model: 'long-source' } }), stream: [] }, { surfaceOp: 'append' })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}
it('long tool output indexes durable bounded parts, resumes exactly, and expands middle/tail source ranges', async () => {
  const h = await setup(); const bodies = new Map<string, string>(); const writes: string[] = []
  try {
    toolTurn(h.session, '开头标记' + '甲'.repeat(32000) + '中间验证标记' + '乙'.repeat(32000) + '末尾验证标记')
    await h.engine.capture(h.session.id); h.engine.options.maxWorkPerDrain = 1
    h.memory.retain = async (ep, text) => { bodies.set(ep.documentId, text); writes.push(ep.documentId); assert.ok(text.length <= 24000) }
    await h.engine.drain()
    const ep = Object.values(h.engine.record.episodes)[0]!
    assert.ok(ep.parts && ep.parts.length > 1); assert.equal(ep.indexed, false); assert.equal(ep.parts.filter(p => p.indexed).length, 1)
    await h.reopen(); await h.engine.feedback()
    h.ports.reflect = async input => {
      assert.ok(input.evidence.some(e => e.partial)); assert.ok(input.job.partialSources?.length)
      assert.ok(input.job.coverage?.length); assert.ok(input.evidence.reduce((n,e) => n+e.text.length,0) <= 24000)
      return { auditId: 'bounded-reflection', proposal: { updates: [] } }
    }
    await h.engine.drain(); await h.engine.drain()
    const completed = h.engine.record.episodes[ep.id]!
    assert.equal(completed.indexed, true); assert.equal(completed.processed, true)
    assert.equal(writes.length, completed.parts!.length); assert.equal(new Set(writes).size, writes.length)
    const middle = [...bodies].find(([,text]) => text.includes('中间验证标记'))!
    h.memory.recall = async () => [{ id: 'middle-fact', documentId: middle[0], text: '中间验证标记' }]
    const recall = await h.engine.recall('中间内容', new AbortController().signal)
    assert.ok(recall.hits[0]?.ranges?.length)
    const source = completed.sources.find(s => s.kind === 'tool' && h.logs.get(s.sessionId)![s.seq]?.type === 'tool/result')!
    const original = (await h.engine.evidence([completed], Infinity)).find(e => e.source.id === source.id)!.text
    for (const marker of ['中间验证标记','末尾验证标记']) {
      const start = original.indexOf(marker), result = await h.engine.readSources([source.id], [{ sourceId: source.id, start, end: start+marker.length }])
      assert.equal(result.sources[0]?.text, marker); assert.equal(result.partial, true)
    }
    const firstWindow = await h.engine.readSources([source.id]); assert.equal(firstWindow.partial, true); assert.ok(firstWindow.sources[0]!.end <= 8000)
    assert.ok(JSON.stringify(firstWindow).length <= 8000, 'source metadata must fit the native pruner budget too')
    await assert.rejects(h.engine.readSources([source.id], [{ sourceId: source.id, start: original.length, end: original.length+1 }]), /range exceeds/)
  } finally { await h.close() }
})
it('a lost memory-part receipt retries the same operation/payload after reopening', async () => {
  const h = await setup(); const calls: Array<{ id: string; payload: string }> = []
  try {
    toolTurn(h.session, '合成长结果'.repeat(9000)); await h.engine.capture(h.session.id)
    h.memory.retain = async (ep, payload) => { calls.push({ id: ep.operationId, payload }); if (calls.length === 1) throw new Error('Receipt lost after acceptance') }
    await assert.rejects(h.engine.drain(), /part unconfirmed/)
    const original = Object.values(h.engine.record.episodes)[0]!
    assert.equal(original.parts?.[0]?.indexed, false); assert.equal(original.parts?.[0]?.attempts, 1)
    await h.reopen(); await h.engine.drain(); await h.engine.drain()
    assert.deepEqual(calls[1], calls[0]); assert.equal(new Set(calls.map(c => c.id)).size, original.parts!.length)
    assert.equal(Object.values(h.engine.record.episodes)[0]?.indexed, true)
    assert.equal(Object.values(h.engine.record.episodes)[0]?.parts?.[0]?.attempts, 2)
  } finally { await h.close() }
})
it('small fragment budgets preserve Unicode source ranges and make forward progress', async () => {
  const h = await setup(); const received: Array<{ source: Source; text: string }> = []
  try {
    h.engine.options.maxEvidenceChars = 700
    toolTurn(h.session, '😀'.repeat(1500)); await h.engine.capture(h.session.id)
    h.memory.retain = async (_ep, body) => { assert.ok(body.length <= 700); received.push(...JSON.parse(body).evidence) }
    for (let i = 0; i < 10 && !Object.values(h.engine.record.episodes)[0]?.indexed; i++) await h.engine.drain()
    const ep = Object.values(h.engine.record.episodes)[0]!, source = ep.sources.find(s => h.logs.get(s.sessionId)![s.seq]?.type === 'tool/result')!
    assert.equal(ep.indexed, true)
    const original = (await h.engine.evidence([ep], Infinity)).find(e => e.source.id === source.id)!.text
    assert.equal(received.filter(e => e.source.id === source.id).map(e => e.text).join(''), original)
    assert.ok(ep.parts?.every(p => p.ranges.every(r => r.end > r.start)))
  } finally { await h.close() }
})
it('correction hides partially indexed chunks immediately and deletes every acknowledged part after reopen', async () => {
  const h = await setup()
  try {
    toolTurn(h.session, '旧材料'.repeat(21000)); await h.engine.capture(h.session.id); h.engine.options.maxWorkPerDrain = 1
    await h.engine.drain(); const ep = Object.values(h.engine.record.episodes)[0]!, indexed = ep.parts!.filter(p => p.indexed)
    turn(h.session, 2, '这份材料有误，撤回作为依据'); await h.engine.capture(h.session.id)
    const by = Object.values(h.engine.record.episodes)[1]!.sources[0]!
    await h.engine.correct([ep.sources[0]!.id], by, '材料撤回')
    h.memory.recall = async () => indexed.map(p => ({ id: p.id, documentId: p.documentId, text: '仍存在的旧事实' }))
    assert.deepEqual((await h.engine.recall('旧材料', new AbortController().signal)).hits, [])
    await h.reopen(); await h.engine.drain()
    assert.ok(indexed.every(p => h.removed.includes(p.documentId)))
    assert.ok(h.engine.record.episodes[ep.id]!.parts!.every(p => !p.indexed))
  } finally { await h.close() }
})
it('host schedule/job activity is attributed, durable and never a direct user feedback source', async () => {
  const h = await setup()
  try {
    h.session.append('turn/start', { turn: 1 })
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '定时提醒到达' }], source: { kind: 'schedule', form: 'instructions' } }), { surfaceOp: 'append' })
    h.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '收到提醒，不代表任务已完成。' }], source: { provider: 'contract', model: 'activity' } }), stream: [] }, { surfaceOp: 'append' })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const fact = { jobId: JobId('bash-test'), owner: h.session.id, kind: 'bash', label: 'owned background task', startedAt: 1 }
    h.session.append('job/registered', fact)
    h.session.append('job/settled', { ...fact, finishedAt: 2, status: 'failed', cause: 'producer', producerReported: true, detail: 'exit code: 3' })
    await h.engine.capture(h.session.id); const episodes = Object.values(h.engine.record.episodes)
    assert.equal(episodes.length, 2); assert.equal(episodes[0]?.sources[0]?.kind, 'activity')
    const text = JSON.stringify(await h.engine.evidence([episodes[1]!], 24000))
    assert.ok(text.includes('failed')); assert.ok(text.includes('registration is not completion'))
    await assert.rejects(h.engine.feedback(episodes[0]!.sources[0]!, { kind: 'method-outcome', polarity: 'positive', quote: '定时提醒到达' }), /bound direct user/)
    await h.reopen(); await h.engine.capture(h.session.id); assert.equal(Object.keys(h.engine.record.episodes).length, 2)
  } finally { await h.close() }
})
it('durable replay is idempotent, routes belong to evidence turns, no-update batches are acknowledged', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '今晚不想听建议'); turn(h.session, 2, '刚才先听我说就很好')
    await h.engine.capture(h.session.id); await h.engine.capture(h.session.id)
    assert.equal(Object.keys(h.engine.record.episodes).length, 2)
    assert.deepEqual(Object.values(h.engine.record.episodes).map(ep => ep.route?.model), ['model-1', 'model-2'])
    await h.engine.drain(); assert.equal(h.retained.length, 2); assert.equal(h.reflectCount, 1)
    await h.reopen(); await h.engine.capture(h.session.id); await h.engine.drain()
    assert.equal(h.retained.length, 2); assert.equal(h.reflectCount, 1); assert.equal(h.engine.record.revision, 0)
    assert.ok(Object.values(h.engine.record.episodes).every(ep => ep.processed))
  } finally { await h.close() }
})
it('unbound sessions and injected runtime/recall material never become new experiences', async () => {
  const h = await setup()
  try {
    const other = h.ctx.sessions.create(SessionId('ordinary'), { meta: { cwd: process.cwd() } }); turn(other, 1, '普通会话的秘密')
    await h.engine.capture(other.id); assert.equal(Object.keys(h.engine.record.episodes).length, 0)
    h.session.append('turn/start', { turn: 1 })
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '旧往事不是新经历' }], source: { kind: 'plugin:role-agent', form: 'recall' } }), { surfaceOp: 'append' })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await h.engine.capture(h.session.id); assert.equal(Object.keys(h.engine.record.episodes).length, 0)
  } finally { await h.close() }
})
it('re-enrollment starts at the explicit role boundary and does not ingest earlier ordinary chat', async () => {
  const h = await setup()
  try {
    await h.engine.unbind(h.session.id); turn(h.session, 1, '普通模式里的私人话题')
    await h.engine.bind(h.session.id, h.session.seq); turn(h.session, 2, '进入角色模式后的话题')
    await h.engine.capture(h.session.id)
    const episodes = Object.values(h.engine.record.episodes)
    assert.equal(episodes.length, 1)
    const evidence = await h.engine.evidence(episodes, 24000)
    assert.equal(evidence.some(e => e.text.includes('普通模式里的私人话题')), false)
    assert.equal(evidence.some(e => e.text.includes('进入角色模式后的话题')), true)
  } finally { await h.close() }
})
it('unloading the engine aborts an in-flight foreground semantic query', async () => {
  const h = await setup()
  try {
    h.memory.recall = async (_query, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('query cancelled on unload')), { once: true })
    })
    const settled = assert.rejects(h.engine.recall('往事', new AbortController().signal), /cancelled on unload/)
    await h.engine.close(); await settled
  } finally { await h.close() }
})
it('backend failure retains source ledger and operation identity for retry across reopen', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '我们说过失约的事情'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[0]!
    h.memory.retain = async () => { throw new Error('connection lost after submission') }
    await assert.rejects(h.engine.drain()); assert.equal(h.engine.record.episodes[ep.id]?.indexed, false)
    await h.reopen()
    h.memory.retain = async item => { assert.equal(item.operationId, ep.operationId); h.retained.push(item.id) }
    await h.engine.drain(); assert.equal(h.retained.length, 1)
  } finally { await h.close() }
})
it('automatic write retries stop at the persistent budget, including after restart', async () => {
  const h = await setup(); let attempts = 0
  try {
    turn(h.session, 1, '需要保存的真实互动'); await h.engine.capture(h.session.id)
    h.memory.retain = async () => { attempts++; throw new Error('backend unavailable') }
    for (let n = 0; n < 3; n++) await assert.rejects(h.engine.drain())
    await h.reopen(); await h.engine.drain(); await h.engine.drain()
    assert.equal(attempts, 3); assert.equal(Object.values(h.engine.record.episodes)[0]?.attempts, 3)
    assert.equal(Object.values(h.engine.record.episodes)[0]?.indexed, false)
  } finally { await h.close() }
})
it('a correction immediately filters remote hits, removes derived beliefs, and rejects stale proposals', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '我不想听建议'); await h.engine.capture(h.session.id); await h.engine.drain()
    const ep = Object.values(h.engine.record.episodes)[0]!; const source = ep.sources[0]!
    const job = { id: 'old', episodes: [ep.id], contextEpisodes: [], revision: 0, evidenceRevision: 0, phase: 'proposed' as const, attempts: 0, auditId: 'old-audit', proposal: { updates: [{ id: 'method1', section: 'methods' as const, text: '倾诉时先听', scope: '未求建议时', sources: [source.id], stage: 'candidate' as const, reason: '明确反馈' }] } }
    await h.table.update('lan', r => ({ ...r, jobs: { old: job } }))
    turn(h.session, 2, '只针对那个晚上，你理解得太广了')
    const event = h.logs.get(h.session.id)!.filter(e => e.type === 'user/message').at(-1)!
    const by: Source = { id: `${digest(h.session.id).slice(0, 16)}:${event.seq}`, sessionId: h.session.id, seq: event.seq, kind: 'user' }
    await h.engine.correct([source.id], by, '缩小适用范围')
    h.memory.recall = async () => [{ id: 'remote-stale', documentId: ep.documentId, text: '旧认识' }, { id: 'foreign', documentId: 'unmapped', text: '其他角色内容' }]
    assert.deepEqual((await h.engine.recall('之前想法', new AbortController().signal)).hits, [])
    await assert.rejects(h.engine.commit('old'), /stale/)
    await h.reopen(); assert.ok(h.engine.record.invalidSources.includes(source.id))
    await h.engine.drain(); assert.ok(h.removed.includes(ep.documentId))
  } finally { await h.close() }
})
it('reflection is isolated, evidence is complete, duplicate commit cannot grow twice', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '我只是想吐槽'); turn(h.session, 2, '对，就是刚才先听我说的方式很好')
    await h.engine.capture(h.session.id)
    h.ports.reflect = async input => {
      assert.equal(input.evidence.length, 4); assert.equal(input.route.model, 'model-2')
      return { auditId: 'audited', proposal: { updates: [{ id: 'method', section: 'methods', text: '未求建议时先倾听', scope: '倾诉', sources: input.evidence.map(e => e.source.id), stage: 'candidate', reason: '用户明确反馈' }] } } satisfies ReflectionResult
    }
    await h.engine.drain(); const job = Object.values(h.engine.record.jobs)[0]!
    assert.equal(h.engine.record.revision, 1); assert.equal(h.engine.record.beliefs.length, 1)
    await h.engine.commit(job.id); assert.equal(h.engine.record.revision, 1)
    await h.reopen(); assert.equal(h.engine.record.beliefs[0]?.text, '未求建议时先倾听')
  } finally { await h.close() }
})
it('correcting a user claim also invalidates beliefs citing the reply from that same episode', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '我住在苏州', '你住在苏州，我记下了。')
    await h.engine.capture(h.session.id); await h.engine.drain()
    const ep = Object.values(h.engine.record.episodes)[0]!
    const user = ep.sources.find(s => s.kind === 'user')!
    const answer = ep.sources.find(s => s.kind === 'assistant')!
    await h.table.update('lan', r => ({ ...r, beliefs: [{ id: 'derived', section: 'openItems', text: '下次继续聊苏州生活', scope: '居住地', sources: [answer.id], stage: 'candidate', reason: '复述用户提供的地点' }] }))
    turn(h.session, 2, '更正，我现在住杭州，之前的苏州记录过时了')
    const proof = h.logs.get(h.session.id)!.filter(e => e.type === 'user/message').at(-1)!
    const by: Source = { id: `${digest(h.session.id).slice(0,16)}:${proof.seq}`, sessionId: h.session.id, seq: proof.seq, kind: 'user' }
    await h.engine.correct([user.id], by, '居住地已变更')
    assert.equal(h.engine.record.beliefs.length, 0)
    assert.ok(h.engine.record.invalidSources.includes(answer.id))
  } finally { await h.close() }
})
it('a short feedback batch includes the previous processed reply without reprocessing it', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '今天只想倾诉'); turn(h.session, 2, '谢谢你先听我说')
    await h.engine.capture(h.session.id); await h.engine.drain()
    turn(h.session, 3, '刚才那样就很好'); await h.engine.capture(h.session.id); await h.engine.feedback()
    h.ports.reflect = async input => {
      assert.equal(input.job.episodes.length, 1); assert.equal(input.job.contextEpisodes.length, 1)
      assert.equal(input.evidence.length, 4)
      return { auditId: 'feedback-audit', proposal: { updates: [] } }
    }
    await h.engine.drain()
    assert.equal(Object.values(h.engine.record.episodes).filter(e => e.processed).length, 3)
    assert.equal(h.engine.record.revision, 0)
  } finally { await h.close() }
})
it('unknown output fields, fabricated sources and untried supported skills are rejected', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '按你的意思试试'); turn(h.session, 2, '这次有帮助'); await h.engine.capture(h.session.id)
    assert.throws(() => proposalSchema.parse({ updates: [], core: 'replace identity' }))
    const ep = Object.values(h.engine.record.episodes)[0]!
    const invalid = { updates: [{ id: 'forged', section: 'stance' as const, text: '随意结论', scope: '无范围', sources: ['unknown-source'], stage: 'candidate' as const, reason: '编造' }] }
    assert.throws(() => validateProposal(h.engine.record, { id: 'forged-job', episodes: [ep.id], contextEpisodes: [], revision: 0, evidenceRevision: 0, phase: 'pending', attempts: 0 }, invalid), /absent or invalid/)
    assert.throws(() => proposalSchema.parse({ updates: [{ ...invalid.updates[0], core: 'replace identity' }] }))
    h.ports.reflect = async input => ({ auditId: 'audit', proposal: { updates: [{ id: 'bad', section: 'methods', text: '已经掌握', scope: '所有情况', sources: [input.evidence[0]!.source.id], stage: 'supported', reason: '自称成功' }] } })
    await assert.rejects(h.engine.drain(), /actual trials/); assert.equal(h.engine.record.revision, 0)
  } finally { await h.close() }
})
const httpOptions = { endpoint: 'http://memory.invalid', bankId: 'private-role', apiKey: 'NEVER_PRINT_ME', timeoutMs: 1000, maxResponseBytes: 4096, pollMs: 1, maxPolls: 2, maxTokens: 1000 }
it('a rejected model proposal is regenerated with feedback and the durable retry budget', async () => {
  const h = await setup(); let calls = 0
  try {
    turn(h.session, 1, '先听我说'); turn(h.session, 2, '这样就很好'); await h.engine.capture(h.session.id)
    h.ports.reflect = async input => {
      calls++
      if (calls === 2) assert.ok(input.job.error?.includes('candidate'))
      return { auditId: `audit-${calls}`, proposal: { updates: [{ id: 'listening', section: 'methods', text: '先确认感受', scope: '倾诉未求建议', sources: [input.evidence[0]!.source.id], stage: calls === 1 ? 'tried' : 'candidate', reason: '明确反馈' }] } }
    }
    await assert.rejects(h.engine.drain(), /actual trials/)
    assert.equal(Object.values(h.engine.record.jobs)[0]?.phase, 'pending')
    await h.reopen(); await h.engine.drain()
    assert.equal(calls, 2); assert.equal(h.engine.record.beliefs[0]?.stage, 'candidate')
    assert.equal(Object.values(h.engine.record.jobs)[0]?.attempts, 2)
    await h.engine.drain(); assert.equal(calls, 2)
  } finally { await h.close() }
})
it('an old rejected proposal remains readable and can be regenerated after reopening', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '你可以说不同意见'); await h.engine.capture(h.session.id); await h.engine.drain()
    const ep = Object.values(h.engine.record.episodes)[0]!
    await h.table.update('lan', r => ({ ...r, jobs: { legacy: { id: 'legacy', episodes: [ep.id], contextEpisodes: [], revision: 0, evidenceRevision: 0, phase: 'proposed', attempts: 1, auditId: 'legacy-audit', proposal: { updates: [{ id: 'old', section: 'relationship', stage: 'supported', text: '旧的不合规提案', scope: '本次讨论', sources: [ep.sources[0]!.id], reason: '旧版本留下的被拒提案' }] } } } }))
    await h.reopen()
    await assert.rejects(h.engine.drain())
    assert.equal(h.engine.record.jobs.legacy?.phase, 'pending')
    await h.engine.drain()
    assert.equal(h.engine.record.jobs.legacy?.phase, 'committed')
    assert.equal(h.engine.record.beliefs.length, 0)
    assert.equal(h.engine.record.jobs.legacy?.attempts, 2)
  } finally { await h.close() }
})
async function trialFixture() {
  const h = await setup()
  turn(h.session, 1, '今天只想倾诉', '我先听你讲。'); await h.engine.capture(h.session.id)
  const first = Object.values(h.engine.record.episodes)[0]!
  const method = { id: 'listen', section: 'methods' as const, stage: 'candidate' as const, text: '明确倾诉时先听', scope: '明确求倾听', sources: first.sources.map(s => s.id), reason: '候选方式' }
  await h.table.update('lan', r => ({ ...r, beliefs: [method] }))
  turn(h.session, 2, '这次也先让我讲完', '我先听你讲完，再问是否需要分析。'); await h.engine.capture(h.session.id)
  const trial = Object.values(h.engine.record.episodes)[1]!, answer = trial.sources.find(s => s.kind === 'assistant')!
  const job = { id: 'trial', episodes: [trial.id], contextEpisodes: [], revision: 0, evidenceRevision: 0, phase: 'proposed' as const, attempts: 1, proposal: { updates: [{ ...method, stage: 'tried' as const, sources: [...method.sources, answer.id] }] } }
  assert.throws(() => validateProposal(h.engine.record, job, { updates: [{ ...method, stage: 'tried', sources: [...method.sources, trial.sources[0]!.id] }] }), /actual response/)
  await h.table.update('lan', r => ({ ...r, jobs: { ...r.jobs, trial: job } })); await h.engine.commit('trial')
  const committed = h.engine.record.beliefs[0]
  if (committed?.section !== 'methods') throw new Error('Missing committed method')
  return { h, answer, method: committed, trial }
}
function promotion(r: ReturnType<typeof initial>, ep: Episode, method: Extract<ReturnType<typeof initial>['beliefs'][number], { section: 'methods' }>, user: Source) {
  const job = { id: 'supported', episodes: [ep.id], contextEpisodes: [] as string[], revision: r.revision, evidenceRevision: r.evidenceRevision, phase: 'proposed' as const, attempts: 1 }
  return { ...job, proposal: { updates: [{ ...method, stage: 'supported' as const, sources: [...method.sources, user.id] }] } }
}
it('method promotion links positive feedback to a committed actual trial and consumes it once', async () => {
  const { h, method, answer } = await trialFixture()
  try {
    assert.deepEqual(h.engine.record.methodTrials[0]?.sources, [answer.id])
    turn(h.session, 3, '刚才先听再问的方式确实有帮助'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[2]!, user = ep.sources[0]!
    await h.engine.feedback(user, { kind: 'method-outcome', polarity: 'positive', quote: '先听再问的方式确实有帮助', methodId: method.id })
    await h.reopen()
    const job = promotion(h.engine.record, ep, method, user)
    validateProposal(h.engine.record, job, job.proposal)
    assert.equal(h.engine.record.outcomes[0]?.target.id, answer.id)
    await h.table.update('lan', r => ({ ...r, jobs: { ...r.jobs, [job.id]: job } })); await h.engine.commit(job.id); await h.engine.commit(job.id)
    assert.equal(h.engine.record.beliefs[0]?.stage, 'supported'); assert.equal(h.engine.record.revision, 2)
    assert.equal(h.engine.record.outcomes[0]?.consumedBy, job.id)
    await h.engine.feedback(user, { kind: 'method-outcome', polarity: 'positive', quote: '先听再问的方式确实有帮助', methodId: method.id })
    assert.equal(h.engine.record.outcomes.length, 1); assert.equal(h.engine.record.outcomes[0]?.consumedBy, job.id)
  } finally { await h.close() }
})
it('review requests and legacy untyped feedback never authorize a supported method', async () => {
  const { h, method } = await trialFixture()
  try {
    turn(h.session, 3, '今天想听建议，请重新复盘'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[2]!, user = ep.sources[0]!
    await h.engine.feedback(user); await h.engine.feedback(user, { kind: 'review-request' })
    assert.equal(h.engine.record.outcomes.length, 0); assert.equal(h.engine.record.priority, true)
    await h.table.update('lan', r => ({ ...r, feedbackSources: [user.id] }))
    await h.reopen(); const job = promotion(h.engine.record, ep, method, user)
    assert.throws(() => validateProposal(h.engine.record, job, job.proposal), /positive feedback/)
  } finally { await h.close() }
})
it('negative, unclear, unassigned and unrelated-method outcomes cannot support promotion', async () => {
  for (const variant of ['negative', 'unclear', 'unassigned', 'other-method'] as const) {
    const { h, method, answer } = await trialFixture()
    try {
      turn(h.session, 3, variant === 'negative' ? '刚才那样回应没有帮助' : '刚才的回应我还说不清效果'); await h.engine.capture(h.session.id)
      const ep = Object.values(h.engine.record.episodes)[2]!, user = ep.sources[0]!
      if (variant === 'other-method') await h.table.update('lan', r => ({ ...r, beliefs: [...r.beliefs, { ...method, id: 'other' }], methodTrials: [...r.methodTrials, { methodId: 'other', sources: [answer.id], revision: 1 }] }))
      await h.engine.feedback(user, { kind: 'method-outcome', polarity: variant === 'negative' || variant === 'unclear' ? variant : 'positive', quote: variant === 'negative' ? '没有帮助' : '说不清效果', ...(variant === 'unassigned' ? {} : { methodId: variant === 'other-method' ? 'other' : method.id }) })
      const job = promotion(h.engine.record, ep, method, user)
      assert.throws(() => validateProposal(h.engine.record, job, job.proposal), /positive feedback/)
    } finally { await h.close() }
  }
})
it('outcome registration rejects fabricated quotes, unknown targets and mismatched methods', async () => {
  const { h, method, trial } = await trialFixture()
  try {
    turn(h.session, 3, '这次确实有帮助'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[2]!, user = ep.sources[0]!
    const input = { kind: 'method-outcome' as const, polarity: 'positive' as const, quote: '这次确实有帮助', methodId: method.id }
    await assert.rejects(h.engine.feedback(user, { ...input, quote: '编造的原话' }), /verbatim/)
    await assert.rejects(h.engine.feedback(user, { ...input, targetSourceId: 'foreign:999' }), /prior completed/)
    await assert.rejects(h.engine.feedback(user, { ...input, targetSourceId: ep.sources.find(s => s.kind === 'assistant')!.id }), /prior completed/)
    await assert.rejects(h.engine.feedback(user, { ...input, targetSourceId: trial.sources[0]!.id }), /prior completed/)
    await assert.rejects(h.engine.feedback(user, { ...input, methodId: 'invented' }), /method does not exist/)
    await assert.rejects(h.engine.feedback({ ...user, kind: 'assistant' }, input), /bound direct user/)
    assert.equal(h.engine.record.outcomes.length, 0)
  } finally { await h.close() }
})
it('correcting a trial invalidates its outcome and makes an in-flight promotion stale', async () => {
  const { h, method, answer } = await trialFixture()
  try {
    turn(h.session, 3, '刚才确实有帮助'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[2]!, user = ep.sources[0]!
    const oldJob = promotion(h.engine.record, ep, method, user)
    await h.engine.feedback(user, { kind: 'method-outcome', polarity: 'positive', quote: '确实有帮助', methodId: method.id })
    assert.throws(() => validateProposal(h.engine.record, oldJob, oldJob.proposal), /stale/)
    const job = promotion(h.engine.record, ep, method, user)
    turn(h.session, 4, '更正，这个判断不适用于那一次'); await h.engine.capture(h.session.id)
    const by = Object.values(h.engine.record.episodes)[3]!.sources[0]!
    await h.engine.correct([answer.id], by, '撤销该次试用依据')
    assert.equal(h.engine.record.outcomes[0]?.valid, false); assert.equal(h.engine.record.methodTrials.length, 0)
    assert.throws(() => validateProposal(h.engine.record, job, job.proposal), /stale/)
  } finally { await h.close() }
})
it('old records default to no classified outcomes or trials, without trusting legacy feedback', () => {
  const { outcomes: _outcomes, methodTrials: _trials, ...old } = initial('lan', 'role-lan')
  old.feedbackSources = ['legacy-positive-looking-source']
  const restored = spec.tables.characters.valueSchema.parse(old)
  assert.deepEqual(restored.outcomes, []); assert.deepEqual(restored.methodTrials, [])
  assert.deepEqual(restored.feedbackSources, old.feedbackSources)
})
it('a fresh evaluated trial is expanded and jointly cited before support can commit', async () => {
  const { h, method } = await trialFixture()
  try {
    turn(h.session, 3, '这一次我也想先讲完', '我先听你讲，再确认是否需要建议。'); await h.engine.capture(h.session.id)
    const fresh = Object.values(h.engine.record.episodes)[2]!, target = fresh.sources.find(s => s.kind === 'assistant')!
    turn(h.session, 4, '这次先听再确认的方式确实有帮助'); await h.engine.capture(h.session.id)
    const feedback = Object.values(h.engine.record.episodes)[3]!, by = feedback.sources[0]!
    await h.engine.feedback(by, { kind: 'method-outcome', polarity: 'positive', quote: '先听再确认的方式确实有帮助', methodId: method.id })
    const job = promotion(h.engine.record, feedback, method, by)
    assert.throws(() => validateProposal(h.engine.record, job, job.proposal), /positive feedback/)
    job.contextEpisodes.push(fresh.id)
    job.proposal.updates[0]!.sources.push(target.id)
    validateProposal(h.engine.record, job, job.proposal)
    await h.table.update('lan', r => ({ ...r, jobs: { ...r.jobs, [job.id]: job } })); await h.engine.commit(job.id)
    assert.ok(h.engine.record.methodTrials.some(t => t.methodId === method.id && t.sources.includes(target.id)))
  } finally { await h.close() }
})
it('later negative evaluation of the same trial blocks selective use of its older positive feedback', async () => {
  const { h, method, answer } = await trialFixture()
  try {
    turn(h.session, 3, '刚才先听的方式有帮助'); await h.engine.capture(h.session.id)
    const first = Object.values(h.engine.record.episodes)[2]!
    await h.engine.feedback(first.sources[0]!, { kind: 'method-outcome', polarity: 'positive', quote: '先听的方式有帮助', methodId: method.id })
    turn(h.session, 4, '回看那次回应，我的实际评价是没有帮助'); await h.engine.capture(h.session.id)
    const second = Object.values(h.engine.record.episodes)[3]!
    await h.engine.feedback(second.sources[0]!, { kind: 'method-outcome', polarity: 'negative', quote: '实际评价是没有帮助', methodId: method.id, targetSourceId: answer.id })
    const job = promotion(h.engine.record, first, method, first.sources[0]!)
    job.episodes.push(second.id)
    assert.throws(() => validateProposal(h.engine.record, job, job.proposal), /positive feedback/)
  } finally { await h.close() }
})
it('a partial review of the evaluated response cannot support a method', async () => {
  const { h, method, answer } = await trialFixture()
  try {
    turn(h.session, 3, '刚才先听再问的方式确实有帮助'); await h.engine.capture(h.session.id)
    const ep = Object.values(h.engine.record.episodes)[2]!, by = ep.sources[0]!
    await h.engine.feedback(by, { kind: 'method-outcome', polarity: 'positive', quote: '先听再问的方式确实有帮助', methodId: method.id })
    const job = promotion(h.engine.record, ep, method, by)
    validateProposal(h.engine.record, job, job.proposal)
    assert.throws(() => validateProposal(h.engine.record, { ...job, partialSources: [answer.id] }, job.proposal), /positive feedback/)
  } finally { await h.close() }
})
it('cross-session outcome targets must predate the feedback and belong to complete episodes', async () => {
  const { h, method, answer } = await trialFixture()
  try {
    turn(h.session, 3, '这次有帮助'); await h.engine.capture(h.session.id)
    const by = Object.values(h.engine.record.episodes)[2]!.sources[0]!
    const other = h.ctx.sessions.create(SessionId('concurrent-trial'), { meta: { cwd: process.cwd() } }); await h.engine.bind(other.id)
    turn(other, 1, '另外一次倾诉', '另一次回应'); await h.engine.capture(other.id)
    const ep = Object.values(h.engine.record.episodes).find(e => e.sessionId === other.id)!, target = ep.sources.find(s => s.kind === 'assistant')!
    const log = h.logs.get(other.id)!, index = log.findIndex(e => e.seq === target.seq)
    const original = log[index]!, feedbackEvent = h.logs.get(h.session.id)![by.seq]!
    log[index] = { ...original, time: feedbackEvent.time + 1 }
    await assert.rejects(h.engine.feedback(by, { kind: 'method-outcome', polarity: 'positive', quote: '有帮助', methodId: method.id, targetSourceId: target.id }), /prior completed/)
    log[index] = original
    await h.table.update('lan', r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...ep, complete: false } } }))
    await assert.rejects(h.engine.feedback(by, { kind: 'method-outcome', polarity: 'positive', quote: '有帮助', targetSourceId: target.id }), /prior completed/)
    await h.engine.feedback(by, { kind: 'method-outcome', polarity: 'positive', quote: '有帮助', methodId: method.id, targetSourceId: answer.id })
    assert.equal(h.engine.record.outcomes.length, 1)
  } finally { await h.close() }
})
it('a method may retain its own validated provenance across sessions, but cannot borrow another belief provenance', async () => {
  const h = await setup()
  try {
    turn(h.session, 1, '倾诉时先听', '我先听你说。'); await h.engine.capture(h.session.id)
    const previous = Object.values(h.engine.record.episodes)[0]!
    const belief = { id:'listen',section:'methods' as const,stage:'candidate' as const,text:'先听',scope:'明确倾诉',sources:previous.sources.map(s=>s.id),reason:'初始候选' }
    await h.table.update('lan',r=>({...r,beliefs:[belief]}))
    const next=h.ctx.sessions.create(SessionId('new-trial-session'),{meta:{cwd:process.cwd()}});await h.engine.bind(next.id)
    turn(next,1,'今天想继续倾诉','我先听你讲完。');await h.engine.capture(next.id)
    const trial=Object.values(h.engine.record.episodes).find(e=>e.sessionId===next.id)!
    const reply=trial.sources.find(s=>s.kind==='assistant')!
    const job={id:'cross-session',episodes:[trial.id],contextEpisodes:[],revision:0,evidenceRevision:0,phase:'pending' as const,attempts:0}
    validateProposal(h.engine.record,job,{updates:[{...belief,stage:'tried',sources:[...belief.sources,reply.id]}]})
    assert.throws(()=>validateProposal(h.engine.record,job,{updates:[{...belief,id:'unrelated-new-method',sources:[...belief.sources,reply.id]}]}),/absent or invalid/)
  } finally { await h.close() }
})
function sampleEpisode(): Episode { return { id: 'e1', sessionId: 's1', end: 9, sources: [], documentId: 'doc-e1', operationId: operationId('stable-batch'), attempts: 0, indexed: false, processed: false, valid: true, complete: true } }
it('Hindsight uses a private bank, async stable identity, bounded completion polling and attributable hits', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const ep = sampleEpisode()
  const backend = new Hindsight(httpOptions, async (url, init) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    calls.push({ path, method: init?.method ?? 'GET', body })
    if (path.endsWith('/memories')) return Response.json({ operation_id: ep.operationId })
    if (path.includes('/operations/')) return Response.json({ status: 'completed' })
    if (path.endsWith('/recall')) return Response.json({ results: [{ id: 'f1', text: '失约后的失望', document_id: ep.documentId }, { id: 'unattributed', text: 'no source' }] })
    return Response.json({})
  })
  await backend.retain(ep, '原始互动', new AbortController().signal)
  await backend.retain(ep, '原始互动', new AbortController().signal)
  assert.equal(calls.filter(c => c.path.endsWith('/memories')).length, 2)
  assert.deepEqual(calls.filter(c => c.path.endsWith('/memories'))[0]?.body, calls.filter(c => c.path.endsWith('/memories'))[1]?.body)
  assert.ok(calls.every(c => c.path.startsWith('/v1/default/banks/private-role')))
  assert.equal((await backend.recall('答应了却没来', new AbortController().signal)).length, 1)
  await backend.remove(ep.documentId, new AbortController().signal)
  assert.equal(calls.at(-1)?.method, 'DELETE')
})
it('backend errors never become empty success, leak credentials, or accept mismatched operation IDs', async () => {
  const backend = new Hindsight(httpOptions, async () => new Response('NEVER_PRINT_ME', { status: 503 }))
  await assert.rejects(backend.recall('x', new AbortController().signal), error => error instanceof Error && error.message === 'Hindsight HTTP 503')
  await assert.rejects(new Hindsight({ ...httpOptions, endpoint: '' }).recall('x', new AbortController().signal), /not configured/)
  const invalid = new Hindsight(httpOptions, async () => new Response('NEVER_PRINT_ME invalid json'))
  await assert.rejects(invalid.prepare(new AbortController().signal), error => error instanceof Error && error.message === 'Hindsight invalid JSON response')
  const mismatch = new Hindsight(httpOptions, async url => Response.json(String(url).endsWith('/memories') ? { operation_id: operationId('wrong') } : {}))
  await assert.rejects(mismatch.retain(sampleEpisode(), 'x', new AbortController().signal), /mismatched/)
})
it('oversized responses and pending operations fail without acknowledging indexed success', async () => {
  const large = new Hindsight({ ...httpOptions, maxResponseBytes: 8 }, async () => new Response('0123456789'))
  await assert.rejects(large.prepare(new AbortController().signal), /budget/)
  const ep = sampleEpisode()
  const pending = new Hindsight(httpOptions, async url => Response.json(String(url).endsWith('/memories') ? { operation_id: ep.operationId } : String(url).includes('/operations/') ? { status: 'pending' } : {}))
  await assert.rejects(pending.retain(ep, 'x', new AbortController().signal), /pending/)
})
