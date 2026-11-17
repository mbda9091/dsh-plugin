import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import type {} from '@deepseek-ai/dsh-schedule'
import type { MemoryBackend } from './hindsight.js'
import { digest, operationId, proposalSchema, feedbackInputSchema, validateProposal, type FeedbackInput, type RoleRecord, type RoleTable, type Source, type SourceRange, type Episode, type Job, type Proposal } from './state.js'

export interface ReflectionInput { job: Job; record: RoleRecord; evidence: Array<{ source: Source; text: string; ranges?: SourceRange[]; partial?: boolean }>; route: LlmCallConfig }
export interface ReflectionResult { proposal: Proposal; auditId: string; usage?: string }
export interface EngineOptions { characterId: string; batchTurns: number; maxEvidenceChars: number; maxBeliefs: number; maxHits: number; maxResultChars: number; maxWorkPerDrain: number; maxAttempts: number; memoryPartChars?: number }
export interface EnginePorts {
  backend: MemoryBackend
  read(sessionId: string, from: number, length: number, signal: AbortSignal): Promise<readonly SessionEvent[]>
  reflect(input: ReflectionInput, signal: AbortSignal): Promise<ReflectionResult>
  route(episode: Episode): LlmCallConfig | undefined
  error(message: string): void
}
function textOf(event: SessionEvent): string | undefined {
  if (event.type === 'user/message' && event.data.source.kind === 'user' && event.surfaceOp === 'append') return event.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  if (event.type === 'user/message' && ['schedule', 'tool-jobs', 'goal'].includes(event.data.source.kind) && event.surfaceOp === 'append') return `[Host activity (${event.data.source.kind}); not direct user feedback or proof of success]\n${event.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')}`
  if (event.type === 'job/registered' || event.type === 'job/settled') return `[Host ${event.type}; registration is not completion, reported completion is not independent verification]\n${JSON.stringify(event.data)}`
  if (event.type === 'assistant/message' && event.surfaceOp === 'append') return `${event.data.interrupted ? '[interrupted assistant prefix; not a completed statement]\n' : ''}${event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')}`
  if (event.type === 'tool/call' && !event.data.name.startsWith('role_')) return `Tool attempt ${event.data.name} callId=${event.data.callId} arguments=${event.data.arguments}`
  if (event.type === 'tool/result' && event.surfaceOp === 'append') return `[Tool reported ${event.data.message.isError ? 'failure' : 'result, not independent proof of an external action'}; callId=${event.data.message.toolCallId}]\n${event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')}`
  return undefined
}
export function episodeFromEvents(namespace: string, sessionId: string, events: readonly SessionEvent[]): Episode | undefined {
  const end = events.at(-1)
  if (end?.type !== 'turn/end' && end?.type !== 'job/settled') return undefined
  const excluded = new Set(events.filter(e => e.type === 'tool/call' && e.data.name.startsWith('role_')).map(e => e.type === 'tool/call' ? e.data.callId : ''))
  const sources: Source[] = []
  for (const e of events) {
    if (e.type === 'tool/result' && excluded.has(e.data.message.toolCallId)) continue
    if (!textOf(e)) continue
    if ((e.type === 'job/registered' || e.type === 'job/settled') && e.data.owner !== sessionId) continue
    sources.push({ id: `${digest(sessionId).slice(0, 16)}:${e.seq}`, sessionId, seq: e.seq, kind: e.type === 'user/message' ? e.data.source.kind === 'user' ? 'user' : 'activity' : e.type === 'assistant/message' ? 'assistant' : e.type === 'job/registered' || e.type === 'job/settled' ? 'activity' : 'tool' })
  }
  if (!sources.some(s => s.kind === 'user' || s.kind === 'activity')) return undefined
  const id = digest(`${namespace}:${sessionId}:${end.seq}`)
  return { id, sessionId, end: end.seq + 1, sources, documentId: `episode-${id}`, operationId: operationId(`${namespace}:${id}`), attempts: 0, indexed: false, processed: false, valid: true,
    complete: end.type === 'job/settled' ? true : end.data.reason.kind === 'completed' && sources.some(s => s.kind === 'assistant') && !events.some(e => e.type === 'assistant/message' && e.data.interrupted),
  }
}

/** A single character's serialized worker. The real KV update remains the commit boundary. */
export class RoleEngine {
  private work: Promise<void> = Promise.resolve()
  private stopped = false
  readonly abort = new AbortController()
  constructor(readonly table: RoleTable, readonly options: EngineOptions, private readonly ports: EnginePorts) {}
  get record(): RoleRecord { const r = this.table.get(this.options.characterId); if (!r) throw new Error('Role state unavailable'); return r }
  private change(fn: (r: RoleRecord) => RoleRecord): Promise<RoleRecord> { return this.table.update(this.options.characterId, fn) }
  async bind(sessionId: string, offset = 0): Promise<void> {
    await this.change(r => Object.hasOwn(r.bindings, sessionId) ? r : { ...r, bindings: { ...r.bindings, [sessionId]: offset } })
  }
  async unbind(sessionId: string): Promise<void> {
    await this.change(r => { const bindings = { ...r.bindings }; delete bindings[sessionId]; return { ...r, bindings } })
  }
  /** Recover from durable boundaries, not a transient notification map. */
  enqueue(action: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Role worker stopped'))
    const task = this.work.then(() => { this.abort.signal.throwIfAborted(); return action() })
    this.work = task.catch(() => { this.ports.error('Role background job failed; durable work retained for retry') })
    return task
  }
  async capture(sessionId: string): Promise<void> {
    if (!Object.hasOwn(this.record.bindings, sessionId)) return
    let offset = this.record.bindings[sessionId] ?? 0
    const pending: SessionEvent[] = []
    let count = 0
    let route = this.record.routes[sessionId]
    while (count < this.options.maxWorkPerDrain * 1000) {
      const events = await this.ports.read(sessionId, offset, 500, this.abort.signal)
      if (!events.length) break
      for (const event of events) {
        if (event.type === 'agent-preset/selected' && event.data.agentPreset !== this.record.presetId) { await this.unbind(sessionId); return }
        if (event.seq !== offset) throw new Error('Noncontiguous source log')
        offset++; count++; pending.push(event)
        if (event.type === 'request/header') route = event.data.header.config
        if (event.type !== 'turn/end' && !(event.type === 'job/settled' && !pending.some(e => e.type === 'turn/start'))) continue
        const ep = episodeFromEvents(this.record.namespace, sessionId, pending)
        if (ep && route) ep.route = route
        await this.change(r => ({ ...r, bindings: { ...r.bindings, [sessionId]: offset }, routes: route ? { ...r.routes, [sessionId]: route } : r.routes, episodes: ep ? { ...r.episodes, [ep.id]: r.episodes[ep.id] ?? ep } : r.episodes }))
        pending.length = 0
      }
      if (events.length < 500) break
    }
  }
  async evidence(episodes: readonly Episode[], budget: number, callerSignal: AbortSignal = this.abort.signal): Promise<Array<{ source: Source; text: string }>> {
    const signal = AbortSignal.any([callerSignal, this.abort.signal])
    const result: Array<{ source: Source; text: string }> = []; let length = 0
    for (const ep of episodes) for (const source of ep.sources) {
      if (this.record.invalidSources.includes(source.id)) continue
      const events = await this.ports.read(source.sessionId, source.seq, 1, signal)
      const event = events[0]
      if (!event || event.seq !== source.seq) throw new Error('Source missing from durable log')
      const text = textOf(event)
      if (text === undefined) throw new Error('Source no longer denotes original conversation')
      length += text.length
      if (length > budget) throw new Error('Evidence exceeds budget; batch not acknowledged')
      result.push({ source, text })
    }
    return result
  }
  private payload(evidence: ReflectionInput['evidence']): string {
    return JSON.stringify({ kind: 'observed_conversation_not_verified_claims', evidence })
  }
  private memoryParts(ep: Episode, raw: ReflectionInput['evidence']): NonNullable<Episode['parts']> {
    const limit = this.options.maxEvidenceChars
    const partChars = Math.max(128, Math.min(this.options.memoryPartChars ?? 8000, Math.floor(limit / 2)))
    const groups: SourceRange[][] = []; let group: SourceRange[] = []
    const payload = (ranges: SourceRange[]) => this.payload(ranges.map(range => ({ source: raw.find(e => e.source.id === range.sourceId)!.source, text: raw.find(e => e.source.id === range.sourceId)!.text.slice(range.start, range.end), ranges: [range], partial: range.start !== 0 || range.end !== range.totalChars })))
    for (const item of raw) for (let start = 0; start < item.text.length;) {
      let end = Math.min(item.text.length, start + partChars)
      let range: SourceRange
      for (;;) {
        // Persist UTF-16 offsets, avoiding a split inside a surrogate pair.
        const minimum = /[\uD800-\uDBFF]/.test(item.text[start]!) && /[\uDC00-\uDFFF]/.test(item.text[start + 1] ?? '') ? 2 : 1
        if (end < item.text.length && /[\uD800-\uDBFF]/.test(item.text[end - 1]!) && /[\uDC00-\uDFFF]/.test(item.text[end]!)) end--
        end = Math.max(start + minimum, end)
        range = { sourceId: item.source.id, start, end, totalChars: item.text.length, hash: digest(item.text.slice(start, end)) }
        if (this.payload([{ source: item.source, text: item.text.slice(start, end), ranges: [range], partial: true }]).length <= limit) break
        if (end - start <= minimum) throw new Error('Memory evidence budget too small for source metadata')
        end = start + Math.floor((end - start) / 2)
      }
      if (group.length && payload([...group, range]).length > limit) { groups.push(group); group = [] }
      group.push(range); start = end
    }
    if (group.length) groups.push(group)
    return groups.map(ranges => {
      const id = digest(`${ep.id}:${JSON.stringify(ranges)}`)
      return { id, documentId: `episode-part-${id}`, operationId: operationId(id), ranges, indexed: false, attempts: 0 }
    })
  }
  async drain(): Promise<void> {
    let completed = 0
    for (const original of Object.values(this.record.episodes)) {
      if (completed >= this.options.maxWorkPerDrain) break
      let ep = this.record.episodes[original.id]!
      if (ep.parts) {
        // Each acknowledged part is independently recoverable and deletable.
      } else {
        if (ep.attempts >= this.options.maxAttempts || (ep.valid && ep.indexed) || (!ep.valid && !ep.indexed)) continue
        if (ep.valid) {
          const raw = await this.evidence([ep], Number.POSITIVE_INFINITY)
          if (this.payload(raw).length > this.options.maxEvidenceChars) {
            const parts = this.memoryParts(ep, raw)
            await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, parts } } }))
            ep = this.record.episodes[ep.id]!
          } else {
            completed++
            await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, attempts: ep.attempts + 1 } } }))
            try {
              await this.ports.backend.retain(ep, this.payload(raw), this.abort.signal)
              await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, indexed: true, error: undefined } } }))
            } catch {
              await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, error: 'memory_write_unconfirmed' } } }))
              throw new Error('Semantic memory write unconfirmed')
            }
            continue
          }
        } else {
          completed++
          await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, attempts: ep.attempts + 1 } } }))
          await this.ports.backend.remove(ep.documentId, this.abort.signal)
          await this.change(r => ({ ...r, episodes: { ...r.episodes, [ep.id]: { ...r.episodes[ep.id]!, indexed: false } } }))
          continue
        }
      }
      let raw: ReflectionInput['evidence'] | undefined
      for (let i = 0; i < ep.parts!.length && completed < this.options.maxWorkPerDrain; i++) {
        const current = this.record.episodes[ep.id]!, part = current.parts![i]!
        if (part.attempts >= this.options.maxAttempts || (current.valid ? part.indexed : !part.indexed)) continue
        completed++
        const writePart = async (patch: Partial<typeof part>) => this.change(r => {
          const entry = r.episodes[ep.id]!, parts = [...entry.parts!]; parts[i] = { ...parts[i]!, ...patch }
          return { ...r, episodes: { ...r.episodes, [ep.id]: { ...entry, parts, indexed: parts.every(p => p.indexed), error: parts.some(p => p.error) ? 'memory_part_unconfirmed' : undefined } } }
        })
        await writePart({ attempts: part.attempts + 1 })
        try {
          if (current.valid) {
            raw ??= await this.evidence([current], Number.POSITIVE_INFINITY)
            const evidence = part.ranges.map(range => {
              const item = raw!.find(e => e.source.id === range.sourceId)
              if (!item || item.text.length !== range.totalChars || digest(item.text.slice(range.start, range.end)) !== range.hash) throw new Error('Original source range changed')
              return { source: item.source, text: item.text.slice(range.start, range.end), ranges: [range], partial: range.start !== 0 || range.end !== range.totalChars }
            })
            await this.ports.backend.retain({ ...current, id: part.id, documentId: part.documentId, operationId: part.operationId }, this.payload(evidence), this.abort.signal)
            await writePart({ indexed: true, error: undefined })
          } else {
            await this.ports.backend.remove(part.documentId, this.abort.signal)
            await writePart({ indexed: false, error: undefined })
          }
        } catch {
          await writePart({ error: 'memory_part_unconfirmed' })
          throw new Error('Semantic memory part unconfirmed; durable progress retained')
        }
      }
    }
    await this.reflectPending()
  }
  private async reflectionEvidence(episodes: readonly Episode[]): Promise<ReflectionInput['evidence']> {
    const raw = await this.evidence(episodes, Number.POSITIVE_INFINITY)
    const budget = this.options.maxEvidenceChars
    if (raw.reduce((sum, item) => sum + item.text.length, 0) <= budget) return raw
    // Source references remain durable even when only bounded windows are read.
    // Every represented source gets an explicitly labelled head/tail window.
    const share = Math.floor(budget / Math.max(1, raw.length))
    if (share < 128) throw new Error('Too many sources for reflection budget; batch not acknowledged')
    return raw.map(item => {
      if (item.text.length <= share) return item
      const size = Math.max(1, Math.floor((share - 80) / 2))
      const ranges = [[0, size], [item.text.length - size, item.text.length]].map(([start, end]) => ({ sourceId: item.source.id, start: start!, end: end!, totalChars: item.text.length, hash: digest(item.text.slice(start, end)) }))
      return { source: item.source, text: item.text.slice(0, size) + '\n[Middle omitted, not examined; use source ranges for details]\n' + item.text.slice(-size), ranges, partial: true }
    })
  }
  async reflectPending(): Promise<void> {
    const r = this.record
    const existing = Object.values(r.jobs).find(j => j.phase === 'pending' || j.phase === 'proposed')
    const available = Object.values(r.episodes).filter(e => e.valid && e.complete && !e.processed)
    if (!existing && !r.priority && available.length < this.options.batchTurns) return
    if (!existing && !available.length) return
    let selected = available.slice(0, this.options.batchTurns)
    const contextFor = (targets: readonly Episode[]): Episode[] => {
      const ids = new Set(targets.map(e => e.id)); const context = new Map<string, Episode>()
      for (const target of targets) {
        const prior = Object.values(this.record.episodes).filter(e => e.valid && e.sessionId === target.sessionId && e.end < target.end).sort((a, b) => b.end - a.end)[0]
        if (prior && !ids.has(prior.id)) context.set(prior.id, prior)
      }
      const users = new Set(targets.flatMap(ep => ep.sources.map(s => s.id)))
      for (const outcome of this.record.outcomes.filter(o => o.valid && !o.consumedBy && users.has(o.source.id))) {
        const evaluated = Object.values(this.record.episodes).find(ep => ep.valid && ep.sources.some(s => s.id === outcome.target.id))
        if (evaluated && !ids.has(evaluated.id)) context.set(evaluated.id, evaluated)
      }
      return [...context.values()]
    }
    // Split oversized batches without silently advancing unrepresented sources.
    let evidence: ReflectionInput['evidence'] = []
    if (!existing) {
      while (selected.length) {
        try { evidence = await this.reflectionEvidence([...contextFor(selected), ...selected]); break } catch (error) {
          if (selected.length === 1) throw error
          selected = selected.slice(0, -1)
        }
      }
    }
    let job: Job = existing ? { ...existing } : { id: digest(`${r.namespace}:${r.revision}:${r.evidenceRevision}:${selected.map(e => e.id).join(',')}`), episodes: selected.map(e => e.id), contextEpisodes: contextFor(selected).map(e => e.id), revision: r.revision, evidenceRevision: r.evidenceRevision, phase: 'pending', attempts: 0 }
    if (!existing) {
      job.coverage = evidence.flatMap(e => e.ranges ?? [{ sourceId: e.source.id, start: 0, end: e.text.length, totalChars: e.text.length, hash: digest(e.text) }])
      job.partialSources = evidence.filter(e => e.partial).map(e => e.source.id)
      await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: job } }))
    }
    if (job.revision !== this.record.revision || job.evidenceRevision !== this.record.evidenceRevision || [...job.episodes, ...job.contextEpisodes].some(id => !this.record.episodes[id]?.valid)) {
      await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: { ...job, phase: 'stale' } } })); return
    }
    if (job.phase === 'pending') {
      if (job.attempts >= this.options.maxAttempts) throw new Error('Reflection retry budget exhausted; explicit review/retry required')
      job = { ...job, attempts: job.attempts + 1 }
      await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: { ...job } } }))
      if (existing) {
        evidence = await this.reflectionEvidence([...job.contextEpisodes, ...job.episodes].map(id => this.record.episodes[id]!))
        job.partialSources = evidence.filter(e => e.partial).map(e => e.source.id)
        job.coverage = evidence.flatMap(e => e.ranges ?? [{ sourceId: e.source.id, start: 0, end: e.text.length, totalChars: e.text.length, hash: digest(e.text) }])
      }
      const route = this.ports.route(this.record.episodes[job.episodes.at(-1)!]!)
      if (!route) throw new Error('No recorded reflection model route')
      try {
        const output = await this.ports.reflect({ job, record: this.record, evidence, route }, this.abort.signal)
        const proposal = proposalSchema.parse(output.proposal)
        validateProposal(this.record, job, proposal)
        await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: { ...job, phase: 'proposed', proposal, auditId: output.auditId, usage: output.usage, error: undefined } } }))
      } catch (error) {
        const reason = error instanceof Error && /^(method |supported method |proposal |stale proposal|cannot move a belief|duplicate update id)/.test(error.message) ? error.message : 'Model or schema failed'
        await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: { ...state.jobs[job.id]!, phase: 'pending', proposal: undefined, error: `${reason}. Follow allowedStagesThisCommit; a candidate cannot become supported in this commit. Non-method sections always use candidate. Cite only valid supplied sources.` } } }))
        throw error
      }
    }
    try { await this.commit(job.id) } catch (error) {
      // Also recover rejected proposals persisted by older versions, without
      // ever applying an invalid proposal or resetting the attempt budget.
      await this.change(state => ({ ...state, jobs: { ...state.jobs, [job.id]: { ...state.jobs[job.id]!, phase: job.revision === state.revision && job.evidenceRevision === state.evidenceRevision ? 'pending' : 'stale', proposal: undefined, error: 'Persisted proposal rejected. Regenerate a small, scoped proposal using valid evidence and one-stage method progression.' } } }))
      throw error
    }
  }
  async commit(jobId: string): Promise<void> {
    await this.change(r => {
      const job = r.jobs[jobId]
      if (!job || job.phase === 'committed') return r
      if (!job.proposal || job.phase !== 'proposed') throw new Error('No durably audited proposal')
      const proposal = proposalSchema.parse(job.proposal)
      validateProposal(r, job, proposal)
      if (job.episodes.some(id => !r.episodes[id]?.valid || r.episodes[id]?.processed)) throw new Error('Evidence batch invalid or already processed')
      const ids = new Set(proposal.updates.map(u => u.id))
      const beliefs = [...r.beliefs.filter(b => !ids.has(b.id)), ...proposal.updates]
      if (beliefs.length > this.options.maxBeliefs) throw new Error('Profile budget exceeded')
      const episodes = { ...r.episodes }; for (const id of job.episodes) episodes[id] = { ...episodes[id]!, processed: true }
      const consumed = new Set([...job.episodes, ...job.contextEpisodes].flatMap(id => r.episodes[id]?.sources.map(s => s.id) ?? []))
      const feedbackSources = r.feedbackSources.filter(id => !consumed.has(id))
      const outcomes = r.outcomes.map(o => !o.consumedBy && consumed.has(o.source.id) ? { ...o, consumedBy: jobId } : o)
      const newTrials = proposal.updates.filter(b => b.section === 'methods' && ['tried', 'supported'].includes(b.stage)).flatMap(b => {
        const previous = r.beliefs.find(old => old.id === b.id)
        const sources = [...job.episodes, ...job.contextEpisodes].flatMap(id => r.episodes[id]?.sources ?? [])
          .filter(s => b.sources.includes(s.id) && !previous?.sources.includes(s.id) && ['assistant', 'tool'].includes(s.kind)).map(s => s.id)
        return sources.length ? [{ methodId: b.id, sources, revision: r.revision + 1 }] : []
      })
      return { ...r, revision: r.revision + (proposal.updates.length ? 1 : 0), beliefs, episodes, feedbackSources, outcomes, methodTrials: [...r.methodTrials, ...newTrials], priority: outcomes.some(o => o.valid && !o.consumedBy), jobs: { ...r.jobs, [jobId]: { ...job, phase: 'committed' } } }
    })
  }
  async correct(sourceIds: string[], by: Source, reason: string): Promise<void> {
    const proof = (await this.ports.read(by.sessionId, by.seq, 1, this.abort.signal))[0]
    if (proof?.type !== 'user/message' || proof.data.source.kind !== 'user' || proof.surfaceOp !== 'append' || by.id !== `${digest(by.sessionId).slice(0, 16)}:${by.seq}`) throw new Error('Correction requires a committed direct user source')
    await this.change(r => {
      const all = Object.values(r.episodes).flatMap(e => e.sources)
      if (!sourceIds.length || sourceIds.some(id => !all.some(s => s.id === id))) throw new Error('Correction requires known targets and a committed user source')
      const invalid = new Set([...r.invalidSources, ...sourceIds]); const episodes = { ...r.episodes }
      // The episode is our dependency unit: an assistant reply/tool result may
      // repeat the corrected claim even if a belief cites only that reply.
      for (const [id, ep] of Object.entries(episodes)) if (ep.sources.some(s => invalid.has(s.id))) {
        for (const source of ep.sources) invalid.add(source.id)
        episodes[id] = { ...ep, valid: false, attempts: 0, ...(ep.parts ? { parts: ep.parts.map(p => ({ ...p, attempts: 0 })) } : {}) }
      }
      return { ...r, revision: r.revision + 1, evidenceRevision: r.evidenceRevision + 1, invalidSources: [...invalid], episodes,
        feedbackSources: r.feedbackSources.filter(id => !invalid.has(id)),
        outcomes: r.outcomes.map(o => invalid.has(o.source.id) || invalid.has(o.target.id) ? { ...o, valid: false } : o),
        methodTrials: r.methodTrials.map(t => ({ ...t, sources: t.sources.filter(id => !invalid.has(id)) })).filter(t => t.sources.length > 0),
        beliefs: r.beliefs.filter(b => !b.sources.some(id => invalid.has(id))), priority: true,
        corrections: [...r.corrections, { sources: sourceIds, by: by.id, reason }],
      }
    })
  }
  async feedback(by?: Source, raw: FeedbackInput = { kind: 'review-request' }): Promise<void> {
    const input = feedbackInputSchema.parse(raw)
    if (input.kind === 'review-request') { await this.change(r => ({ ...r, priority: true })); return }
    if (!by || by.kind !== 'user' || !Object.hasOwn(this.record.bindings, by.sessionId)) throw new Error('Feedback requires a bound direct user source')
    const proof = (await this.ports.read(by.sessionId, by.seq, 1, this.abort.signal))[0]
    if (proof?.type !== 'user/message' || proof.seq !== by.seq || proof.data.source.kind !== 'user' || proof.surfaceOp !== 'append' || by.id !== `${digest(by.sessionId).slice(0,16)}:${by.seq}`) throw new Error('Feedback requires a committed direct user source')
    if (!proof.data.content.filter(b => b.type === 'text').some(b => b.text.includes(input.quote))) throw new Error('Feedback quote must occur verbatim in the direct user message')
    const candidates = Object.values(this.record.episodes).filter(ep => ep.valid && ep.complete).flatMap(ep => ep.sources)
      .filter(s => ['assistant', 'tool'].includes(s.kind) && !this.record.invalidSources.includes(s.id))
    const target = input.targetSourceId ? candidates.find(s => s.id === input.targetSourceId)
      : candidates.filter(s => s.kind === 'assistant' && s.sessionId === by.sessionId && s.seq < by.seq).sort((a,b) => b.seq-a.seq)[0]
    if (!target || (target.sessionId === by.sessionId && target.seq >= by.seq)) throw new Error('Feedback target must be a prior completed role response or result')
    const event = (await this.ports.read(target.sessionId, target.seq, 1, this.abort.signal))[0]
    if (!event || event.seq !== target.seq || event.time > proof.time || event.surfaceOp !== 'append' || (target.kind === 'assistant' ? event.type !== 'assistant/message' || event.data.interrupted : event.type !== 'tool/result' || event.data.message.isError)) throw new Error('Feedback target is not a prior completed response or successful tool result')
    await this.change(r => {
      if (r.invalidSources.includes(by.id) || r.invalidSources.includes(target.id) || !Object.hasOwn(r.bindings, by.sessionId) || !Object.values(r.episodes).some(ep => ep.valid && ep.sources.some(s => s.id === target.id))) throw new Error('Feedback source or target invalidated')
      if (input.methodId && !r.beliefs.some(b => b.id === input.methodId && b.section === 'methods')) throw new Error('Feedback method does not exist in this role')
      const id = digest(`${by.id}:${target.id}:${input.methodId ?? ''}`)
      const outcome = { id, source: by, target, quote: input.quote, polarity: input.polarity, ...(input.methodId ? { methodId: input.methodId } : {}), valid: true }
      const old = r.outcomes.find(o => o.id === id)
      if (old) {
        if (old.quote !== outcome.quote || old.polarity !== outcome.polarity) throw new Error('Feedback already registered with different meaning; correct its source instead')
        return r
      }
      // A concurrent P3 prepared before registration must be re-evaluated.
      return { ...r, priority: true, evidenceRevision: r.evidenceRevision + 1, outcomes: [...r.outcomes, outcome] }
    })
  }
  async readSources(ids: string[], ranges: Array<{ sourceId: string; start: number; end: number }> = [], signal: AbortSignal = this.abort.signal): Promise<{ sources: Array<{ source: Source; text: string; start: number; end: number; totalChars: number; complete: boolean }>; partial: boolean }> {
    const selected = Object.values(this.record.episodes).filter(ep => ep.valid && ep.sources.some(s => ids.includes(s.id)))
    const sources = [...new Map(selected.flatMap(ep => ep.sources).filter(s => ids.includes(s.id) && !this.record.invalidSources.includes(s.id)).map(s => [s.id, s])).values()]
    if (sources.length !== new Set(ids).size || ranges.some(r => !ids.includes(r.sourceId)) || new Set(ranges.map(r => r.sourceId)).size !== ranges.length) throw new Error('Unknown, duplicate or invalid source range')
    const raw = []
    for (const source of sources) {
      const event = (await this.ports.read(source.sessionId, source.seq, 1, signal))[0]
      if (!event || event.seq !== source.seq) throw new Error('Source missing from durable log')
      const text = textOf(event)
      if (text === undefined) throw new Error('Source no longer denotes original conversation')
      const request = ranges.find(r => r.sourceId === source.id), start = request?.start ?? 0, wanted = request?.end ?? text.length
      if (start < 0 || wanted <= start || wanted > text.length) throw new Error('Source range exceeds original text')
      raw.push({ source, text, start, wanted })
    }
    const result = raw.map(item => ({ source: item.source, text: '', start: item.start, end: item.start, totalChars: item.text.length, complete: false }))
    const size = () => JSON.stringify({ sources: result, partial: true }).length
    if (size() >= this.options.maxResultChars) throw new Error('Source metadata exceeds result budget; request fewer sourceIds')
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]!, entry = result[i]!
      const set = (end: number) => { entry.end = end; entry.text = item.text.slice(item.start, end); entry.complete = item.start === 0 && end === item.text.length }
      let low = item.start, high = item.wanted
      while (low < high) {
        const end = Math.ceil((low + high) / 2); set(end)
        if (size() < this.options.maxResultChars) low = end; else high = end - 1
      }
      set(low)
    }

    return { sources: result, partial: result.some(s => !s.complete) }
  }
  async recall(query: string, signal: AbortSignal): Promise<{ hits: Array<{ text: string; sources: Source[]; ranges?: SourceRange[] }>; partial: boolean }> {
    const hits = await this.ports.backend.recall(query, AbortSignal.any([signal, this.abort.signal])); const result: Array<{ text: string; sources: Source[]; ranges?: SourceRange[] }> = []; let chars = 0
    for (const hit of hits) {
      const ep = Object.values(this.record.episodes).find(e => e.documentId === hit.documentId || e.parts?.some(p => p.documentId === hit.documentId))
      const part = ep?.parts?.find(p => p.documentId === hit.documentId)
      if (!ep?.valid || (part ? !part.indexed : !ep.indexed) || ep.sources.some(s => this.record.invalidSources.includes(s.id))) continue
      if (chars + hit.text.length > this.options.maxResultChars || result.length >= this.options.maxHits) break
      chars += hit.text.length
      result.push({ text: hit.text, sources: part ? ep.sources.filter(s => part.ranges.some(r => r.sourceId === s.id)) : ep.sources, ...(part ? { ranges: part.ranges } : {}) })
    }
    return { hits: result, partial: Object.values(this.record.episodes).some(e => e.valid && !e.indexed) || result.length < hits.length }
  }
  async close(): Promise<void> { this.stopped = true; this.abort.abort(); await this.work }
}
