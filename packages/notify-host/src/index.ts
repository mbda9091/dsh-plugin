/**
 * Shared Host notification trigger logic.
 *
 * Both delivery adapters use this module: it owns the global `session/event`
 * listener, root-Agent filtering, question lifecycle, approval delay/cancellation, and the
 * `turn/end` decision. It emits serializable notification intents and knows
 * nothing about Windows, HTTP, SSE, browser permissions, or the current UI
 * selection.
 *
 * The module is a build-time workspace library. esbuild inlines it into each
 * plugin, so a profile never installs `@local/notify-host` at runtime.
 *
 * @module @local/notify-host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
// Type-only imports: they augment Context with `agents` and SessionEventMap with
// `approval/asked` / `approval/decided`.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-tools'

/** Trigger configuration shared by both adapters. */
export interface TriggerOptions {
  /** Notify when a root session asks the human to answer a question card. */
  readonly notifyOnQuestion: boolean
  /** Notify when a root-session tool asks for approval. */
  readonly notifyOnApproval: boolean
  /** Delay before an approval notification; a decision inside it cancels. */
  readonly approvalDelayMs: number
  /** Notify when a root-session turn completes or reaches max tokens. */
  readonly notifyOnTurnEnd: boolean
  /** Notify when a root-session turn ends with an error. */
  readonly notifyOnTurnError: boolean
}

/** The notification family carried by one update. */
export type NotificationKind = 'approval' | 'question' | 'turn-end'

/** A serializable approval notification intent. */
export interface ApprovalShowUpdate {
  readonly type: 'show'
  readonly kind: 'approval'
  /** Stable across the approval's lifecycle and reconnect. */
  readonly id: string
  readonly sessionId: string
  /** Source session event sequence. */
  readonly seq: number
  /** Source session event time in Unix milliseconds. */
  readonly at: number
  readonly toolName: string
  readonly reason?: string
}

/** A question card derived from a committed tool invocation. */
export interface QuestionShowUpdate {
  readonly type: 'show'
  readonly kind: 'question'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly question: string
}

export type PendingShowUpdate = ApprovalShowUpdate | QuestionShowUpdate

/** A serializable turn-end notification intent. */
export interface TurnEndShowUpdate {
  readonly type: 'show'
  readonly kind: 'turn-end'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly reasonKind: string
  readonly errorMessage?: string
}

/** Withdraw one previously emitted approval or question notification. */
export interface WithdrawUpdate {
  readonly type: 'withdraw'
  readonly kind: 'approval' | 'question'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
}

/** Every update an adapter may receive. */
export type NotificationUpdate = PendingShowUpdate | TurnEndShowUpdate | WithdrawUpdate

/** The notification source created by {@link createNotificationSource}. */
export interface NotificationSource {
  /**
   * Subscribe to future updates. The source does not replay; adapters use
   * {@link NotificationSource.snapshotPending} for current state.
   */
  subscribe(listener: (update: NotificationUpdate) => void): () => void
  /** Currently visible approvals and unanswered question cards. */
  snapshotPending(): PendingShowUpdate[]
  /** Remove listeners, timers, and all derived state. Safe to call twice. */
  dispose(): void
}

interface PendingApproval {
  readonly state: ApprovalShowUpdate
  readonly session: Session
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Whether a Session belongs to a live root Agent.
 *
 * An unavailable or failing Agent registry yields `false`: without positive
 * root evidence the source stays silent rather than treating a subagent as a
 * conversation the user should be summoned for.
 *
 * @param ctx - Host context.
 * @param session - Session that appended the event.
 * @returns whether the Agent is a live root.
 */
function isRootSession(ctx: Context, session: Session): boolean {
  const agents = ctx.get('agents')
  if (agents === undefined) return false
  try {
    const agent = agents.list().find((item) => item.session.id === session.id)
    return agent !== undefined && agents.roots().includes(agent)
  } catch {
    return false
  }
}

/**
 * Bound one user-visible line before it enters the wire payload. The Browser
 * applies the same visible limit through `notify-core`; this only keeps a
 * transport message small and normalizes whitespace once.
 *
 * @param value - raw reason or error message.
 * @returns a bounded single line.
 */
function boundMessage(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

/**
 * Create the shared notification source.
 *
 * @param ctx - Host context with `agents` available.
 * @param options - shared trigger options.
 * @returns the source; callers own its lifetime.
 */
export function createNotificationSource(ctx: Context, options: TriggerOptions): NotificationSource {
  const listeners = new Set<(update: NotificationUpdate) => void>()
  /** Approval timers waiting for {@link TriggerOptions.approvalDelayMs}. */
  const pending = new Map<string, PendingApproval>()
  /** Pending approval and question intents already emitted. */
  const shown = new Map<string, PendingShowUpdate>()
  let disposed = false

  const emit = (update: NotificationUpdate): void => {
    for (const listener of [...listeners]) {
      try {
        listener(update)
      } catch (error) {
        console.warn('[notify-host] notification listener failed:', error)
      }
    }
  }

  const cancelPending = (id: string): void => {
    const record = pending.get(id)
    if (record === undefined) return
    clearTimeout(record.timer)
    pending.delete(id)
  }

  const withdraw = (update: PendingShowUpdate, seq: number, at: number): void => {
    if (!shown.delete(update.id)) return
    emit({
      type: 'withdraw',
      kind: update.kind,
      id: update.id,
      sessionId: update.sessionId,
      seq,
      at,
    })
  }

  const showQuestion = (session: Session, event: SessionEvent, callId: string, args: string): void => {
    if (!options.notifyOnQuestion || !isRootSession(ctx, session)) return
    const id = `${session.id}:question:${callId}`
    if (shown.has(id)) return
    let question: string
    try {
      const value: unknown = JSON.parse(args)
      if (typeof value !== 'object' || value === null || !('questions' in value) || !Array.isArray(value.questions)) return
      const first: unknown = value.questions[0]
      if (typeof first !== 'object' || first === null || !('question' in first) || typeof first.question !== 'string') return
      question = boundMessage(first.question)
      if (!question) return
    } catch { return }
    const state: QuestionShowUpdate = { type: 'show', kind: 'question', id, sessionId: session.id, seq: event.seq, at: event.time, question }
    shown.set(id, state)
    emit(state)
  }

  const isPendingQuestionResult = (content: Extract<SessionEvent, { type: 'tool/result' }>['data']['message']['content']): boolean => {
    const text = content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') return false
    try {
      const value: unknown = JSON.parse(text.text)
      return typeof value === 'object' && value !== null && 'pending' in value && value.pending === true
    } catch { return false }
  }

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      showQuestion(session, event, String(event.data.callId), event.data.arguments)
      return
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'ask_user_question') {
      if (!event.data.isError && isPendingQuestionResult(event.data.content)) {
        showQuestion(session, event, String(event.data.subCallId), JSON.stringify(event.data.arguments))
      }
      return
    }
    if (event.type === 'tool/result') {
      const visible = shown.get(`${session.id}:question:${String(event.data.message.toolCallId)}`)
      // A timed-out card remains answerable; only an answer, failure or agent
      // disposal removes it. Resume repair also preserves unknown outcomes.
      if (visible && event.data.error?.code !== 'TOOL_OUTCOME_UNKNOWN'
        && (event.data.error !== undefined || event.data.message.isError === true || !isPendingQuestionResult(event.data.message.content))) {
        withdraw(visible, event.seq, event.time)
      }
      return
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user-question-reply') {
      const visible = shown.get(`${session.id}:question:${String(event.data.source.callId)}`)
      if (visible) withdraw(visible, event.seq, event.time)
      return
    }

    if (event.type === 'approval/decided') {
      // Handle decisions before the root check: an Agent may already be gone,
      // and its pending timer/visible approval still needs cleanup.
      const id = `${session.id}:approval:${String(event.data.id)}`
      cancelPending(id)
      const visible = shown.get(id)
      if (visible !== undefined) withdraw(visible, event.seq, event.time)
      return
    }

    if (event.type === 'approval/asked') {
      if (!options.notifyOnApproval || !isRootSession(ctx, session)) return
      const id = `${session.id}:approval:${String(event.data.id)}`
      if (pending.has(id) || shown.has(id)) return
      const state: ApprovalShowUpdate = {
        type: 'show',
        kind: 'approval',
        id,
        sessionId: session.id,
        seq: event.seq,
        at: event.time,
        toolName: event.data.toolName,
        ...event.data.reason === undefined ? {} : { reason: boundMessage(event.data.reason) },
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        if (disposed || !isRootSession(ctx, session)) return
        shown.set(id, state)
        emit(state)
      }, Math.max(0, Math.floor(options.approvalDelayMs)))
      timer.unref?.()
      pending.set(id, { state, session, timer })
      return
    }

    if (event.type !== 'turn/end') return
    if (!isRootSession(ctx, session)) return
    const reason: TurnEndReason = event.data.reason
    if (reason.kind === 'completed' || reason.kind === 'max-tokens') {
      if (!options.notifyOnTurnEnd) return
    } else if (reason.kind === 'error') {
      if (!options.notifyOnTurnError) return
    } else {
      return
    }
    const update: TurnEndShowUpdate = {
      type: 'show',
      kind: 'turn-end',
      id: `${session.id}:turn-end:${event.seq}`,
      sessionId: session.id,
      seq: event.seq,
      at: event.time,
      reasonKind: reason.kind,
      ...reason.kind === 'error' ? { errorMessage: boundMessage(reason.error.message) } : {},
    }
    emit(update)
  }

  const onAgentDisposed = (payload: { agent: { session: { id: string } } }): void => {
    const sessionId = payload.agent.session.id
    for (const [id, record] of [...pending]) {
      if (record.state.sessionId !== sessionId) continue
      clearTimeout(record.timer)
      pending.delete(id)
    }
    for (const [id, record] of [...shown]) {
      if (record.sessionId !== sessionId) continue
      shown.delete(id)
      emit({
        type: 'withdraw',
        kind: record.kind,
        id,
        sessionId,
        seq: record.seq,
        at: Date.now(),
      })
    }
  }

  const disposeSessionEvent = ctx.on('session/event', onSessionEvent, { global: true })
  const disposeAgentDisposed = ctx.on('agent/disposed', onAgentDisposed, { global: true })

  return {
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshotPending() {
      return [...shown.values()]
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const record of pending.values()) clearTimeout(record.timer)
      pending.clear()
      shown.clear()
      listeners.clear()
      disposeSessionEvent()
      disposeAgentDisposed()
    },
  }
}
