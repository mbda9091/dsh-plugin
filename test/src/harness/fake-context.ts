/**
 * The slice of a Cordis Context the plugins under test touch: service lookup
 * and event registration. Listeners are recorded so tests can invoke them with
 * hand-built session events.
 */
export type AnyFunction = (...args: never[]) => unknown

export interface Listener {
  readonly event: string
  readonly handler: (...args: unknown[]) => unknown
  readonly options: unknown
}

export interface FakeContext {
  readonly services: Map<string, unknown>
  readonly listeners: Listener[]
  get(name: string): unknown
  on(event: string, handler: (...args: unknown[]) => unknown, options?: unknown): () => void
  /** Invoke every listener registered for `event`, returning their results. */
  emit(event: string, ...args: unknown[]): unknown[]
  /** Await every listener registered for `event`, in registration order. */
  emitAsync(event: string, ...args: unknown[]): Promise<unknown[]>
}

export function createFakeContext(services: Record<string, unknown> = {}): FakeContext {
  const listeners: Listener[] = []
  const context: FakeContext = {
    services: new Map(Object.entries(services)),
    listeners,
    get: (name) => context.services.get(name),
    on: (event, handler, options) => {
      listeners.push({ event, handler, options })
      return () => {
        const index = listeners.findIndex((item) => item.event === event && item.handler === handler)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    emit: (event, ...args) =>
      listeners.filter((item) => item.event === event).map((item) => item.handler(...args)),
    emitAsync: async (event, ...args) => {
      const results: unknown[] = []
      for (const item of listeners.filter((entry) => entry.event === event)) {
        results.push(await item.handler(...args))
      }
      return results
    },
  }

  // A real Cordis context exposes services as properties as well as through
  // `get()`. Plugins use both forms (`ctx.commands`, `ctx.get('agents')`).
  for (const [name, value] of Object.entries(services)) {
    if (name in context) continue
    Object.defineProperty(context, name, { value, enumerable: true, configurable: true })
  }

  return context
}
