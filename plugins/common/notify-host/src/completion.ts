import { rootAgents } from './agents.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TurnEndShowUpdate } from './index.js'

interface Candidate {
  readonly agent: Agent
  readonly update: TurnEndShowUpdate
  readonly controller: AbortController
  readonly goals: GoalService | undefined
  readonly subagents: SubagentRuntime | undefined
}

export interface CompletionGate {
  consider(agent: Agent, session: Session, update: TurnEndShowUpdate): void
  invalidate(sessionId: string): void
  dispose(): void
}

const CANCELLED = Symbol('cancelled')

/** Cordis creates a fresh traced proxy on each get(); compare its provider. */
function provider(service: object | undefined): object | undefined {
  return service === undefined ? undefined : Reflect.get(service, Symbol.for('cordis.original')) ?? service
}

type Outcome<T> = { value: T } | { error: unknown }

/** One native Promise reaction, with removable observers for successive turns. */
class PendingWork<T> {
  private outcome: Outcome<T> | undefined
  private readonly listeners = new Set<(outcome: Outcome<T>) => void>()
  get settled(): boolean { return this.outcome !== undefined }

  constructor(work: Promise<T>) {
    // The runtime retains only this container. Aborted observers are removed,
    // so an unfinished child never accumulates closures from old root turns.
    void work.then(value => this.finish({ value }), error => this.finish({ error }))
  }

  private finish(outcome: Outcome<T>): void {
    this.outcome = outcome
    for (const listener of [...this.listeners]) listener(outcome)
    this.listeners.clear()
  }

  observe(signal: AbortSignal): Promise<T | typeof CANCELLED> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.listeners.delete(done)
        signal.removeEventListener('abort', cancel)
      }
      const done = (outcome: Outcome<T>): void => {
        cleanup()
        if ('error' in outcome) reject(outcome.error)
        else resolve(outcome.value)
      }
      const cancel = (): void => { cleanup(); resolve(CANCELLED) }
      if (signal.aborted) cancel()
      else if (this.outcome !== undefined) done(this.outcome)
      else {
        this.listeners.add(done)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
  }
}

function pendingWork<T>(cache: WeakMap<Agent, PendingWork<T>>, agent: Agent, start: () => Promise<T>): PendingWork<T> {
  const existing = cache.get(agent)
  if (existing !== undefined && !existing.settled) return existing
  const work = new PendingWork(start())
  cache.set(agent, work)
  return work
}

/** Web completion policy: a finished turn is only a candidate, not a goal result. */
export function createCompletionGate(ctx: Context, emit: (update: TurnEndShowUpdate) => void): CompletionGate {
  const candidates = new Map<string, Candidate>()
  const seen = new WeakMap<Agent, number>()
  const idleWaits = new WeakMap<Agent, PendingWork<void>>()
  const childWaits = new WeakMap<object, WeakMap<Agent, PendingWork<boolean>>>()
  let disposed = false

  const invalidate = (sessionId: string): void => {
    const candidate = candidates.get(sessionId)
    if (candidate === undefined) return
    candidates.delete(sessionId)
    candidate.controller.abort()
  }

  const current = (candidate: Candidate): boolean => {
    const { agent } = candidate
    const agents = ctx.get('agents')
    return !disposed && candidates.get(agent.session.id) === candidate
      && agents !== undefined && agents.get(agent.session.id) === agent && rootAgents(ctx).includes(agent)
      && provider(ctx.get('goals')) === provider(candidate.goals)
      && provider(ctx.get('subagents')) === provider(candidate.subagents)
  }

  const ready = (candidate: Candidate): boolean => {
    if (!current(candidate)) return false
    const { agent, goals } = candidate
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return false
    const goal = goals?.get(agent)
    return goal === undefined || goal.phase === 'complete'
  }

  const check = async (candidate: Candidate): Promise<void> => {
    const { agent, controller } = candidate
    try {
      if (await pendingWork(idleWaits, agent, () => agent.whenIdle()).observe(controller.signal) === CANCELLED || !ready(candidate)) return
      if (candidate.subagents !== undefined) {
        const service = candidate.subagents
        const identity = provider(service)!
        let waits = childWaits.get(identity)
        if (waits === undefined) { waits = new WeakMap(); childWaits.set(identity, waits) }
        const joined = await pendingWork(waits, agent, () => service.waitForTreeWork(agent)).observe(controller.signal)
        // Once child work has advanced, its result must be consumed in a new
        // root turn. Sending the old root turn's notification would be stale.
        if (joined === CANCELLED || joined || !ready(candidate)) return
      }
      if (ready(candidate)) emit(candidate.update)
    } catch (error) {
      if (!controller.signal.aborted && !disposed) console.warn('[notify-host] completion check failed:', error)
    } finally {
      if (candidates.get(agent.session.id) === candidate) invalidate(agent.session.id)
    }
  }

  const disposeInbox = ctx.on('agent/inbox/inserted', ({ agent }) => invalidate(agent.session.id), { global: true })

  return {
    consider(agent, session, update) {
      if (disposed || agent.session !== session || update.seq <= (seen.get(agent) ?? -1)) return
      seen.set(agent, update.seq)
      invalidate(session.id)
      const candidate: Candidate = {
        agent, update, controller: new AbortController(),
        goals: ctx.get('goals'), subagents: ctx.get('subagents'),
      }
      candidates.set(session.id, candidate)
      void check(candidate)
    },
    invalidate,
    dispose() {
      if (disposed) return
      disposed = true
      for (const id of [...candidates.keys()]) invalidate(id)
      disposeInbox()
    },
  }
}
