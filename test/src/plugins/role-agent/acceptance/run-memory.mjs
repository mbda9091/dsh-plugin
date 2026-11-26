// Explicit opt-in: real Hindsight/DeepSeek calls on synthetic, isolated banks.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseEnv } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { RoleEngine, Hindsight, initial, spec, digest } from "../../../../../plugins/role-agent/lib/index.js"

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize synthetic paid memory extraction')
const root = resolve('.'), fixtureBytes = readFileSync(new URL('./semantic-cases.json', import.meta.url))
const cases = JSON.parse(fixtureBytes), env = parseEnv(readFileSync('plugins/role-agent/deploy/hindsight/.env', 'utf8'))
const endpoint = `http://127.0.0.1:${env.HINDSIGHT_API_PORT || 8888}`, key = env.ROLE_HINDSIGHT_API_KEY
assert.ok(key)
mkdirSync('.tmp/m3', { recursive: true })
const run = mkdtempSync(resolve('.tmp/m3/memory-')), bank = `role-m3-${randomUUID()}`, foreignBank = `${bank}-foreign`
const report = { version: 1, startedAt: new Date().toISOString(), fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), bank, model: env.HINDSIGHT_LLM_MODEL || 'deepseek-flash',
  scope: 'Real memory backend + real DSH domain/Session events; not a full Agent conversation test', parameters: { topK: 5, maxTokens: 2000, maxPolls: 240, pollMs: 500 }, checks: {}, queries: [], cleanup: false }
const signal = AbortSignal.timeout(20 * 60 * 1000)
const api = async (id, path, method = 'GET', body) => {
  const r = await fetch(`${endpoint}/v1/default/banks/${id}${path}`, { method, signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!r.ok) { await r.body?.cancel(); throw new Error(`Hindsight HTTP ${r.status}`) }
  const text = await r.text(); return text ? JSON.parse(text) : {}
}
const ctx = new Context(), storage = new Storage(ctx), disk = new JsonStorageBackend(join(run, 'domain'))
storage.backend.register('json', disk)
const facility = new DomainFacility(ctx, { backend: 'json' })
let domain = await facility.open(spec), table = domain.table('characters')
await table.put('lan', { ...initial('lan', 'role-lan'), namespace: bank })
new SessionStore(ctx)
const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: run } })
ctx.on('session/event', (s, e) => appendFileSync(join(run, `${s.id}.jsonl`), JSON.stringify(e) + '\n'), { global: true })
const sourceRead = async (id, start, length) => readFileSync(join(run, `${id}.jsonl`), 'utf8').trim().split('\n').map(s => JSON.parse(s)).slice(start, start + length)
const options = { endpoint, bankId: bank, apiKey: key, timeoutMs: 30000, maxResponseBytes: 1048576, pollMs: 500, maxPolls: 240, maxTokens: 2000 }
const hindsight = new Hindsight(options), other = new Hindsight({ ...options, bankId: foreignBank })
let lastRaw = [], writes = 0
const backend = { prepare: s => hindsight.prepare(s), retain: async (...args) => { await hindsight.retain(...args); console.log(`indexed ${++writes}/${cases.documents.length}`) }, remove: (...args) => hindsight.remove(...args), recall: async (...args) => { lastRaw = await hindsight.recall(...args); return lastRaw } }
const engineOptions = { characterId: 'lan', batchTurns: 1000, maxEvidenceChars: 24000, maxBeliefs: 24, maxHits: 5, maxResultChars: 8000, maxWorkPerDrain: 128, maxAttempts: 3 }
const ports = { backend, read: sourceRead, reflect: async () => { throw new Error('Reflection must not run in retrieval-only suite') }, route: e => e.route, error: () => {} }
let engine = new RoleEngine(table, engineOptions, ports)
await engine.bind(session.id)
const mapping = new Map(), byDoc = new Map()
function turn(item, n) {
  session.append('turn/start', { turn: n }); session.append('step/start', { turn: n, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: item.user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: n, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: item.answer }], source: { provider: 'fixture', model: 'recorded' } }), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: n, step: 1 }); session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}
try {
  assert.equal(cases.queries.length, 40)
  for (const [i, item] of cases.documents.entries()) {
    turn(item, i + 1); await engine.capture(session.id)
    const ep = Object.values(engine.record.episodes).at(-1)
    mapping.set(item.id, ep); byDoc.set(ep.documentId, item.id)
  }
  await engine.drain()
  report.checks.allDocumentsIndexed = Object.values(engine.record.episodes).every(e => e.indexed)
  // Real async operation replay must not produce new extracted facts.
  const first = mapping.get('tea'), evidence = await engine.evidence([first], 24000)
  await hindsight.retain(first, JSON.stringify({ kind: 'observed_conversation_not_verified_claims', evidence }), signal)
  report.checks.stableOperationReplay = true
  await other.prepare(signal)
  for (const item of cases.foreign) {
    await other.retain({ id: item.id, documentId: item.id, operationId: randomUUID(), sessionId: 'foreign', sources: [] }, item.user + '\n' + item.answer, signal)
  }
  const correctionEvent = (await sourceRead(session.id, 0, session.seq)).find(e => e.type === 'user/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('更正：')))
  const by = { id: `${digest(session.id).slice(0, 16)}:${correctionEvent.seq}`, sessionId: session.id, seq: correctionEvent.seq, kind: 'user' }
  const invalid = cases.documents.filter(d => d.replacedBy).flatMap(d => mapping.get(d.id).sources.map(s => s.id))
  await engine.correct(invalid, by, 'Synthetic explicit corrections: old records superseded')
  // Check the local barrier while stale remote documents still exist.
  const stale = await engine.recall('之前的居住地苏州和宠物狗', signal)
  assert.ok(stale.hits.every(h => h.sources.every(s => !invalid.includes(s.id))))
  report.checks.immediateInvalidationBarrier = true
  // Prevent P3 in this retrieval-only test; invalidated documents must still be deleted.
  await table.update('lan', r => ({ ...r, priority: false }))
  await engine.drain()
  await engine.close(); await domain.close()
  domain = await facility.open(spec); table = domain.table('characters'); engine = new RoleEngine(table, engineOptions, ports)
  assert.equal(engine.record.namespace, bank); assert.ok(invalid.every(id => engine.record.invalidSources.includes(id)))
  const count = Object.keys(engine.record.episodes).length
  await engine.capture(session.id); await engine.drain(); assert.equal(Object.keys(engine.record.episodes).length, count)
  report.checks.durableReopenAndReplay = true
  for (const query of cases.queries) {
    const start = performance.now(), result = await engine.recall(query.query, signal)
    const found = [...new Set(result.hits.flatMap(h => h.sources.map(s => [...mapping].find(([, ep]) => ep.sources.some(t => t.id === s.id))?.[0])).filter(Boolean))]
    let ok = query.expected.every(id => found.includes(id))
    const forbidden = [...cases.documents.filter(d => d.replacedBy).map(d => d.id), ...(query.forbidden ?? [])]
    const leaked = lastRaw.some(h => cases.foreign.some(d => d.id === h.documentId)) || found.some(id => forbidden.includes(id))
    if (leaked) ok = false
    if (query.expand && ok) for (const id of query.expected) {
      const expanded = await engine.evidence([mapping.get(id)], 8000)
      const item = cases.documents.find(d => d.id === id)
      if (!expanded.some(e => e.text === item.user) || !expanded.some(e => e.text === item.answer)) ok = false
    }
    const row = { id: query.id, group: query.group, passed: ok, leaked, expected: query.expected, found, ms: Math.round(performance.now() - start) }
    report.queries.push(row); console.log(`${query.id} ${ok ? 'PASS' : 'FAIL'} ${found.join(',')}`)
  }
  const groups = {}
  for (const q of report.queries) { groups[q.group] ??= { passed: 0, total: 0 }; groups[q.group].total++; groups[q.group].passed += Number(q.passed) }
  const passed = report.queries.filter(q => q.passed).length
  report.summary = { passed, total: 40, groups, passedThreshold: passed >= 34 && groups.lexical.passed >= 9 && groups.paraphrase.passed >= 8 && !report.queries.some(q => q.leaked) }
  // Capture provider-reported calls before deleting banks and their trace rows.
  await new Promise(resolve => setTimeout(resolve, 800))
  const traces = await api(bank, '/llm-requests?limit=500')
  const stats = await api(bank, '/llm-requests/stats')
  writeFileSync(join(run, 'model-traces.json'), JSON.stringify(traces, null, 2) + '\n')
  report.modelTraceStats = stats
  report.modelTraceRows = traces.items?.length ?? 0
  report.modelTraceTotal = traces.total
  report.traceKeys = traces.items?.[0] ? Object.keys(traces.items[0]) : []
} catch (error) { report.error = error instanceof Error ? error.message.replaceAll(key, '[redacted]') : 'unknown error' }
finally {
  await engine.close(); await domain.close(); await disk.close()
  const cleanup = await Promise.allSettled([api(bank, '', 'DELETE'), api(foreignBank, '', 'DELETE')])
  report.cleanup = cleanup.every(r => r.status === 'fulfilled')
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: join(run, 'report.json'), summary: report.summary, error: report.error, cleanup: report.cleanup }))
}
if (report.error || !report.summary?.passedThreshold || !report.cleanup) process.exitCode = 1
