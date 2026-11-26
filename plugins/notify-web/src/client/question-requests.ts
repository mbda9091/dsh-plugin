import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

/** Remote projects the Host Agent to its Client Context. */
export type ClientQuestionRequest = Omit<AskUserQuestionRequestEvent, 'agent'> & { agent?: Context }
export interface QuestionRemote {
  $on(event: 'user-questions/request', listener: (this: Context, request: ClientQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>): () => void
}
export interface ReceivedQuestion {
  readonly owner: Context
  readonly request: ClientQuestionRequest
  readonly id: string
  settled: boolean
}

/** Install during phase one, before the application's card answerer. */
export function observeQuestions(remote: QuestionRemote) {
  const active = new Set<ReceivedQuestion>()
  const abortCleanups = new Map<ReceivedQuestion, () => void>()
  const listeners = new Set<(item: ReceivedQuestion) => void>()
  const publish = (item: ReceivedQuestion) => {
    for (const listener of listeners) {
      try { listener(item) } catch (error) { console.warn('[notify-web] question observer failed:', error) }
    }
  }
  const off = remote.$on('user-questions/request', function(request, next) {
    // Delegate synchronously; never wait for a notification, permission, or HTTP.
    const result = next()
    const item: ReceivedQuestion = { owner: this, request, id: crypto.randomUUID(), settled: false }
    active.add(item)
    publish(item)
    const finish = () => {
      request.signal?.removeEventListener('abort', finish)
      abortCleanups.delete(item)
      if (item.settled) return
      item.settled = true
      active.delete(item)
      publish(item)
    }
    request.signal?.addEventListener('abort', finish, { once: true })
    abortCleanups.set(item, () => request.signal?.removeEventListener('abort', finish))
    if (request.signal?.aborted) finish()
    return result.finally(finish)
  })
  return {
    snapshot: () => [...active],
    subscribe(listener: (item: ReceivedQuestion) => void) {
      listeners.add(listener)
      for (const item of active) listener(item)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      off(); listeners.clear(); active.clear()
      for (const cleanup of abortCleanups.values()) cleanup()
      abortCleanups.clear()
    },
  }
}

export type QuestionObserver = ReturnType<typeof observeQuestions>
