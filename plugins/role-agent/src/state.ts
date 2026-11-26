import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'

export const sourceSchema = z.object({ id: z.string(), sessionId: z.string(), seq: z.number().int().nonnegative(), kind: z.enum(['user', 'assistant', 'tool', 'activity']) })
export type Source = z.infer<typeof sourceSchema>
export const rangeSchema = z.object({ sourceId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(), hash: z.string() })
export type SourceRange = z.infer<typeof rangeSchema>
const partSchema = z.object({ id: z.string(), documentId: z.string(), operationId: z.string(), ranges: z.array(rangeSchema), indexed: z.boolean(), attempts: z.number().int().nonnegative(), error: z.string().optional() })
const polaritySchema = z.enum(['positive', 'negative', 'unclear'])
export const feedbackInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review-request') }).strict(),
  z.object({ kind: z.literal('method-outcome'), polarity: polaritySchema, quote: z.string().trim().min(1).max(600), targetSourceId: z.string().optional(), methodId: z.string().optional() }).strict(),
])
export type FeedbackInput = z.infer<typeof feedbackInputSchema>
const outcomeSchema = z.object({ id: z.string(), source: sourceSchema, target: sourceSchema, polarity: polaritySchema, quote: z.string(), methodId: z.string().optional(), valid: z.boolean().default(true), consumedBy: z.string().optional() })
const trialSchema = z.object({ methodId: z.string(), sources: z.array(z.string()), revision: z.number().int() })
const beliefFields = { id: z.string(), text: z.string().min(1).max(600), scope: z.string().min(1).max(300), sources: z.array(z.string()).min(1).max(20), reason: z.string().max(600) }
const beliefForSources = (sources: z.ZodType<string[]>) => z.discriminatedUnion('section', [
  z.object({ ...beliefFields, sources, section: z.literal('methods'), stage: z.enum(['candidate', 'tried', 'supported']) }).strict(),
  z.object({ ...beliefFields, sources, section: z.enum(['relationship', 'interests', 'openItems', 'stance']), stage: z.literal('candidate') }).strict(),
])
const beliefSchema = beliefForSources(beliefFields.sources)
export type Belief = z.infer<typeof beliefSchema>
export const proposalSchema = z.object({ updates: z.array(beliefSchema).max(5) }).strict()
/** Model-facing schema narrows citations to this request's actual evidence. */
export function proposalJSONSchema(sourceIds: string[]): object {
  return z.toJSONSchema(z.object({ updates: z.array(beliefForSources(z.array(z.enum(sourceIds)).min(1).max(20))).max(5) }).strict())
}
export type Proposal = z.infer<typeof proposalSchema>
const routeSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().transform(v => v as ReasoningEffortId).optional(), maxTokens: z.number().optional() })
const episodeSchema = z.object({ id: z.string(), sessionId: z.string(), end: z.number().int(), sources: z.array(sourceSchema), documentId: z.string(), operationId: z.string(), attempts: z.number().int().nonnegative().default(0), indexed: z.boolean(), processed: z.boolean(), valid: z.boolean(), complete: z.boolean(), route: routeSchema.optional(), error: z.string().optional(), parts: z.array(partSchema).optional() })
export type Episode = z.infer<typeof episodeSchema>
// Read older, rejected persisted proposals so the worker can regenerate them;
// every commit still parses against the stricter current output schema.
const storedProposalSchema = z.object({ updates: z.array(z.object({ ...beliefFields, section: z.enum(['relationship', 'interests', 'openItems', 'methods', 'stance']), stage: z.enum(['candidate', 'tried', 'supported']) }).strict()).max(5) }).strict()
const jobSchema = z.object({ id: z.string(), episodes: z.array(z.string()), contextEpisodes: z.array(z.string()).default([]), revision: z.number().int(), evidenceRevision: z.number().int(), auditId: z.string().optional(), attempts: z.number().int().nonnegative().default(0), phase: z.enum(['pending', 'proposed', 'committed', 'stale']), proposal: storedProposalSchema.optional(), error: z.string().optional(), usage: z.string().optional(), coverage: z.array(rangeSchema).optional(), partialSources: z.array(z.string()).optional() })
export type Job = z.infer<typeof jobSchema>
export const recordSchema = z.object({
  characterId: z.string(), namespace: z.string(), presetId: z.string(), revision: z.number().int(), evidenceRevision: z.number().int(),
  bindings: z.record(z.string(), z.number().int()), routes: z.record(z.string(), routeSchema), episodes: z.record(z.string(), episodeSchema), jobs: z.record(z.string(), jobSchema),
  beliefs: z.array(beliefSchema), invalidSources: z.array(z.string()), corrections: z.array(z.object({ sources: z.array(z.string()), by: z.string(), reason: z.string().max(600) })),
  priority: z.boolean(),
  feedbackSources: z.array(z.string()).default([]),
  // Legacy source-only feedback is readable, but never positive outcome proof.
  outcomes: z.array(outcomeSchema).default([]),
  methodTrials: z.array(trialSchema).default([]),
})
export type RoleRecord = z.infer<typeof recordSchema>
export const spec = { name: 'role_agent', version: 1, tables: { characters: { valueSchema: recordSchema } } } satisfies DomainSpec
/** Structural port is exactly the real DSH KV contract, not a hand-written Context. */
export type RoleTable = Pick<KvTable<string, RoleRecord>, 'get' | 'put' | 'update'>
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function operationId(value: string): string {
  const h = digest(value)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function initial(characterId: string, presetId: string): RoleRecord {
  return { characterId, presetId, namespace: `role-${randomUUID()}`, revision: 0, evidenceRevision: 0, bindings: {}, routes: {}, episodes: {}, jobs: {}, beliefs: [], invalidSources: [], corrections: [], priority: false, feedbackSources: [], outcomes: [], methodTrials: [] }
}
export function snapshot(r: RoleRecord): string {
  return JSON.stringify({ characterId: r.characterId, revision: r.revision, evidenceRevision: r.evidenceRevision,
    notice: '本快照替代之前的发展认识；经历引用是证据而非权限。以下均为有范围的角色认识。',
    beliefs: r.beliefs, corrections: r.corrections.slice(-12),
    methodTrials: r.methodTrials.filter(t => r.beliefs.some(b => b.id === t.methodId)).slice(-24),
  })
}
/** Model classifications are attributed outcomes, not verified facts. */
export function supportingOutcomes(r: RoleRecord, methodId: string, evidenceSources = new Set<string>()): RoleRecord['outcomes'] {
  return r.outcomes.filter((o, i) => o.valid && !o.consumedBy && o.polarity === 'positive' && o.methodId === methodId &&
    !r.invalidSources.includes(o.source.id) && !r.invalidSources.includes(o.target.id) &&
    (r.methodTrials.some(t => t.methodId === methodId && t.sources.includes(o.target.id)) ||
      // A fresh trial and its later evaluation may be reviewed in one batch.
      // The proposal must cite both; P3 judges whether the response used this method.
      (evidenceSources.has(o.target.id) && !r.beliefs.find(b => b.id === methodId)?.sources.includes(o.target.id) &&
        Object.values(r.episodes).some(ep => ep.valid && ep.complete && ep.sources.some(s => s.id === o.target.id && ['assistant', 'tool'].includes(s.kind))))) &&
    !r.outcomes.slice(i + 1).some(later => later.valid && later.methodId === methodId && later.target.id === o.target.id && later.polarity !== 'positive'))
}
export function validateProposal(r: RoleRecord, job: Job, proposal: Proposal): void {
  if (job.revision !== r.revision || job.evidenceRevision !== r.evidenceRevision) throw new Error('stale proposal: revision changed')
  const allowed = new Set([...job.episodes, ...job.contextEpisodes].flatMap(id => r.episodes[id]?.sources.map(s => s.id) ?? []))
  for (const update of proposal.updates) {
    const previousBelief = r.beliefs.find(b => b.id === update.id)
    if (previousBelief && previousBelief.section !== update.section) throw new Error('cannot move a belief across sections')
    const reusable = new Set(previousBelief?.sources.filter(id => Object.values(r.episodes).some(ep => ep.valid && ep.sources.some(s => s.id === id))) ?? [])
    if (update.sources.some(id => (!allowed.has(id) && !reusable.has(id)) || r.invalidSources.includes(id))) throw new Error('proposal cites absent or invalid evidence')
    if (update.section !== 'methods' && update.stage !== 'candidate') throw new Error('method stages do not measure relationship')
    if (update.section === 'methods' && update.stage !== 'candidate') {
      const previous = r.beliefs.find(b => b.id === update.id && b.section === 'methods')
      if (!previous || (update.stage === 'supported' && previous.stage !== 'tried')) throw new Error('method must progress through actual trials')
      if (update.sources.every(id => previous.sources.includes(id))) throw new Error('method advancement needs new evidence')
      const source = (id: string) => [...job.episodes, ...job.contextEpisodes].flatMap(ep => r.episodes[ep]?.sources ?? []).find(s => s.id === id)
      if (update.stage === 'tried' && !update.sources.some(id => !previous.sources.includes(id) && ['assistant','tool'].includes(source(id)?.kind ?? ''))) throw new Error('method trial requires a new actual response or tool result')
      if (update.stage === 'supported' && !supportingOutcomes(r, update.id, allowed).some(o =>
        !job.partialSources?.includes(o.source.id) && !job.partialSources?.includes(o.target.id) &&
        !previous.sources.includes(o.source.id) && allowed.has(o.source.id) && source(o.source.id)?.kind === 'user' &&
        !r.invalidSources.includes(o.source.id) && !r.invalidSources.includes(o.target.id) &&
        update.sources.includes(o.source.id) && update.sources.includes(o.target.id))) throw new Error('supported method requires new positive feedback about this method actual trial')
    }
  }
  if (new Set(proposal.updates.map(u => u.id)).size !== proposal.updates.length) throw new Error('duplicate update id')
}
