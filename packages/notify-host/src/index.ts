/**
 * Shared Host notification trigger logic.
 *
 * The Web delivery adapter uses this module: it owns the global `session/event`
 * listener, root-Agent filtering, approval delay/cancellation, and the
 * `turn/end` decision. It emits serializable notification intents and knows
 * nothing about Windows, HTTP, SSE, browser permissions, or the current UI
 * selection.
 *
 * The module is a build-time workspace library. esbuild inlines it into each
 * plugin, so a profile never installs `@mbda9091/notify-host` at runtime.
 *
 * @module @mbda9091/notify-host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
// Type-only imports: they augment Context with `agents` and SessionEventMap with
// `approval/asked` / `approval/decided`.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import { rootAgents } from './agents.js'
export { rootAgents } from './agents.js'
import { createCompletionGate } from './completion.js'

/** Trigger configuration shared by both adapters. */
export interface TriggerOptions {
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
export type NotificationKind = 'approval' | 'turn-end'

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

/** Withdraw one previously emitted approval notification. */
export interface WithdrawUpdate {
  readonly type: 'withdraw'
  readonly kind: 'approval'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
}

/** Every update an adapter may receive. */
export type NotificationUpdate = ApprovalShowUpdate | TurnEndShowUpdate | WithdrawUpdate

/** The notification source created by {@link createNotificationSource}. */
export interface NotificationSource {
  /**
   * Subscribe to future updates. The source does not replay; adapters use
   * {@link NotificationSource.snapshotPendingApprovals} for current state.
   */
  subscribe(listener: (update: NotificationUpdate) => void): () => void
  /** Currently visible, still-pending approval intents. */
  snapshotPendingApprovals(): ApprovalShowUpdate[]
  /** Remove listeners, timers, and all derived state. Safe to call twice. */
  dispose(): void
}

interface PendingApproval {
  readonly state: ApprovalShowUpdate
  readonly session: Session
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Find the live root Agent owning a Session.
 *
 * An unavailable or failing Agent registry yields `undefined`: without positive
 * root evidence the source stays silent rather than treating a subagent as a
 * conversation the user should be summoned for.
 *
 * @param ctx - Host context.
 * @param session - Session that appended the event.
 * @returns the live root, when positively identified.
 */
function rootAgent(ctx: Context, session: Session): Agent | undefined {
  return rootAgents(ctx).find(item => item.session.id === session.id)
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
 * @param completion - `settled` enables the Web goal/child-work gate; `turn` preserves the original contract.
 * @returns the source; callers own its lifetime.
 */
export function createNotificationSource(ctx: Context, options: TriggerOptions, completion: 'turn' | 'settled' = 'turn'): NotificationSource {
  const listeners = new Set<(update: NotificationUpdate) => void>()
  /** Approval timers waiting for {@link TriggerOptions.approvalDelayMs}. */
  const pending = new Map<string, PendingApproval>()
  /** Approval intents already emitted and not yet decided. */
  const shown = new Map<string, ApprovalShowUpdate>()
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

  // The Web adapter opts into goal-aware completion; other consumers keep
  // their existing turn-based contract without depending on these services.
  const gate = completion === 'settled' ? createCompletionGate(ctx, emit) : undefined

  const cancelPending = (id: string): void => {
    const record = pending.get(id)
    if (record === undefined) return
    clearTimeout(record.timer)
    pending.delete(id)
  }

  const withdraw = (update: ApprovalShowUpdate, seq: number, at: number): void => {
    if (!shown.delete(update.id)) return
    emit({
      type: 'withdraw',
      kind: 'approval',
      id: update.id,
      sessionId: update.sessionId,
      seq,
      at,
    })
  }

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    if (event.type === 'turn/start' || event.type === 'user/message' || event.type === 'goal/change') gate?.invalidate(session.id)
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
      if (!options.notifyOnApproval || rootAgent(ctx, session) === undefined) return
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
        if (disposed || rootAgent(ctx, session) === undefined) return
        shown.set(id, state)
        emit(state)
      }, Math.max(0, Math.floor(options.approvalDelayMs)))
      timer.unref?.()
      pending.set(id, { state, session, timer })
      return
    }

    if (event.type !== 'turn/end') return
    const agent = rootAgent(ctx, session)
    if (agent === undefined) return
    const reason: TurnEndReason = event.data.reason
    if (reason.kind !== 'completed') gate?.invalidate(session.id)
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
    if (gate !== undefined && reason.kind === 'completed') gate.consider(agent, session, update)
    else emit(update)
  }

  const onAgentDisposed = (payload: { agent: { session: { id: string } } }): void => {
    const sessionId = payload.agent.session.id
    gate?.invalidate(sessionId)
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
        kind: 'approval',
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
    snapshotPendingApprovals() {
      return [...shown.values()]
    },
    dispose() {
      if (disposed) return
      disposed = true
      gate?.dispose()
      for (const record of pending.values()) clearTimeout(record.timer)
      pending.clear()
      shown.clear()
      listeners.clear()
      disposeSessionEvent()
      disposeAgentDisposed()
    },
  }
}
