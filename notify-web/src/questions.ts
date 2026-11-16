import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { z } from 'zod'
import { clip } from '@mbda9091/notify-core'
import type { QuestionShowUpdate, QuestionWithdrawUpdate } from './protocol.js'

const questionSchema = z.object({
  callId: z.string(),
  seq: z.number(),
  at: z.number(),
  question: z.string(),
  state: z.enum(['open', 'continued']),
  timed: z.boolean(),
  rootCallId: z.string().optional(),
})
const stateSchema = z.object({
  inheritedEventCount: z.number(),
  timed: z.boolean(),
  active: z.array(questionSchema),
})
type QuestionState = z.infer<typeof stateSchema>
const argumentsSchema = z.object({
  questions: z.array(z.object({ id: z.string(), question: z.string() })).min(1),
})
const pendingSchema = z.object({ pending: z.literal(true) })

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** Pure, replayable state. No tool execution or answerer is intercepted. */
export const questionProjection: ProjectionDefinition<'mbda9091.notifyWebQuestions', QuestionState> = {
  key: 'mbda9091.notifyWebQuestions',
  stateVersion: 2,
  stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, timed: false, active: [] }),
  apply(state, event) {
    if (event.seq < state.inheritedEventCount) return state
    const remove = (callId: string, base = state): QuestionState => base.active.some(item => item.callId === callId)
      ? { ...base, active: base.active.filter(item => item.callId !== callId) }
      : base
    const add = (callId: string, args: unknown, continued: boolean, rootCallId?: string): QuestionState => {
      if (state.active.some(item => item.callId === callId)) return state
      const parsed = argumentsSchema.safeParse(args)
      if (!parsed.success) return state
      return { ...state, active: [...state.active, {
        callId, seq: event.seq, at: event.time,
        question: clip(parsed.data.questions[0]!.question, 180),
        state: continued ? 'continued' : 'open', timed: state.timed || continued,
        ...(rootCallId === undefined ? {} : { rootCallId }),
      }] }
    }
    switch (event.type) {
      case 'request/header': {
        const timed = (event.data.header.tools ?? []).some(tool => tool.name === 'ask_user_question'
          && tool.parameters.properties !== null && typeof tool.parameters.properties === 'object'
          && Object.hasOwn(tool.parameters.properties, 'timeout'))
        return timed === state.timed ? state : { ...state, timed }
      }
      case 'tool/call':
        return event.data.name === 'ask_user_question'
          ? add(event.data.callId, parseJson(event.data.arguments), false) : state
      case 'tool/result': {
        // A drained/repaired parent result ends any subcall that never recorded
        // its own outcome. Continued questions have their own late-reply lifetime.
        const active = state.active.filter(item => item.rootCallId !== event.data.message.toolCallId || item.state === 'continued')
        const base = active.length === state.active.length ? state : { ...state, active }
        const item = base.active.find(item => item.callId === event.data.message.toolCallId)
        if (item === undefined) return base
        const text = event.data.message.content.find(block => block.type === 'text')
        const pending = !event.data.message.isError && event.data.error === undefined
          && text?.type === 'text' && pendingSchema.safeParse(parseJson(text.text)).success
        if (item.timed && (pending || event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN')) {
          return item.state === 'continued' ? base : {
            ...base, active: base.active.map(value => value === item ? { ...value, state: 'continued' } : value),
          }
        }
        return remove(item.callId, base)
      }
      case 'tool/ptc-dispatch-start':
        return event.data.name === 'ask_user_question'
          ? add(event.data.subCallId, event.data.arguments, false, event.data.rootCallId) : state
      case 'tool/ptc-dispatch': {
        if (event.data.name !== 'ask_user_question') return state
        const text = event.data.content.find(block => block.type === 'text')
        if (!event.data.isError && text?.type === 'text' && pendingSchema.safeParse(parseJson(text.text)).success) {
          const item = state.active.find(item => item.callId === event.data.subCallId)
          if (item === undefined) return add(event.data.subCallId, event.data.arguments, true, event.data.rootCallId)
          return item.state === 'continued' ? state : {
            ...state, active: state.active.map(value => value === item ? { ...value, state: 'continued', timed: true } : value),
          }
        }
        return remove(event.data.subCallId)
      }
      case 'user/message':
        return event.data.source.kind === 'user-question-reply' ? remove(event.data.source.callId) : state
      default:
        return state
    }
  },
}

export interface QuestionSource {
  subscribe(listener: (update: QuestionShowUpdate | QuestionWithdrawUpdate) => void): () => void
  snapshot(): QuestionShowUpdate[]
  dispose(): Promise<void>
}

/** Register before exposing consumers, then reconcile live root sessions on committed events. */
export async function createQuestionSource(ctx: Context): Promise<QuestionSource> {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) throw new Error('[notify-web] sessionProjections service is unavailable')
  const handle = await registry.register(questionProjection)
  const listeners = new Set<(update: QuestionShowUpdate | QuestionWithdrawUpdate) => void>()
  const shown = new Map<string, QuestionShowUpdate>()
  let disposed = false
  const emit = (update: QuestionShowUpdate | QuestionWithdrawUpdate): void => {
    for (const listener of [...listeners]) {
      try { listener(update) } catch (error) { console.warn('[notify-web] question listener failed:', error) }
    }
  }
  const reconcile = (session: Session, event?: SessionEvent): void => {
    if (disposed) return
    const root = ctx.get('agents')?.roots().some(agent => agent.session === session) === true
    const active = root ? handle.stateOf(session).active : []
    const ids = new Set(active.map(item => `${session.id}:question:${item.callId}`))
    for (const [id, previous] of shown) {
      if (previous.sessionId !== session.id || ids.has(id)) continue
      shown.delete(id)
      emit({ type: 'withdraw', kind: 'question', id, sessionId: session.id,
        seq: event?.seq ?? previous.seq, at: event?.time ?? Date.now() })
    }
    for (const item of active) {
      const id = `${session.id}:question:${item.callId}`
      if (shown.has(id)) continue
      const update: QuestionShowUpdate = { type: 'show', kind: 'question', id,
        sessionId: session.id, seq: item.seq, at: item.at, question: item.question }
      shown.set(id, update)
      emit(update)
    }
  }
  const offEvent = ctx.on('session/event', reconcile, { global: true })
  const offCreated = ctx.on('agent/created', async ({ agent }) => { reconcile(agent.session) }, { global: true })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, update] of shown) {
      if (update.sessionId !== agent.session.id) continue
      shown.delete(id)
      emit({ type: 'withdraw', kind: 'question', id, sessionId: update.sessionId,
        seq: update.seq, at: Date.now() })
    }
  }, { global: true })
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot() {
      if (disposed) return []
      const roots = ctx.get('agents')?.roots() ?? []
      const live = new Set<string>(roots.map(agent => agent.session.id))
      for (const [id, update] of shown) {
        if (!live.has(update.sessionId)) {
          shown.delete(id)
          emit({ type: 'withdraw', kind: 'question', id, sessionId: update.sessionId,
            seq: update.seq, at: Date.now() })
        }
      }
      for (const agent of roots) reconcile(agent.session)
      return [...shown.values()]
    },
    async dispose() {
      if (disposed) return
      disposed = true
      offEvent(); offCreated(); offDisposed()
      listeners.clear(); shown.clear()
      await handle.dispose()
    },
  }
}
