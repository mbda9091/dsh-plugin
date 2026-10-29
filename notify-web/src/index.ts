/**
 * Web Host half of the notification feature.
 *
 * The Host owns the shared notification source and exposes its serializable
 * updates through an authenticated Server-Sent Events route on the DSH
 * Connection `/api` bridge. The browser Client is the only consumer; the
 * operating system notification and tab focus remain the page's job.
 *
 * @module @local/notify-web
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  createNotificationSource,
  type ApprovalShowUpdate,
  type NotificationUpdate,
  type TriggerOptions,
} from '@local/notify-host'
import { assertTarget } from './targets.js'

// Re-exported so the unit tests can exercise target detection.
export { detectEnvironment, evaluateTarget } from './targets.js'

/** Loader row identity; independent from the package name. */
export const name = 'notify-web'

/** The Host source needs the Agent registry; the SSE route needs Connection. */
export const inject = ['agents', 'connection']

/** Web notification trigger and SSE channel configuration. */
export interface Config {
  /** Notify when a root-session tool asks for approval. @default true */
  notifyOnApproval?: boolean
  /** Delay before an approval notification; a decision inside it cancels. @default 300 */
  approvalDelayMs?: number
  /** Notify when a root-session turn completes or reaches max tokens. @default true */
  notifyOnTurnEnd?: boolean
  /** Notify when a root-session turn ends with an error. @default true */
  notifyOnTurnError?: boolean
  /** SSE heartbeat interval. @default 15000 */
  heartbeatMs?: number
  /** Retained update window for short reconnects. @default 120000 */
  replayWindowMs?: number
  /** Maximum retained updates. @default 256 */
  maxReplayEntries?: number
  /** Maximum queued frames per slow client before it is disconnected. @default 256 */
  maxQueuedUpdates?: number
}

/** {@link Config} with every default applied. */
export type Options = Required<Config>

/** Defaults, merged under the row's `config`. */
export const DEFAULTS: Options = {
  notifyOnApproval: true,
  approvalDelayMs: 300,
  notifyOnTurnEnd: true,
  notifyOnTurnError: true,
  heartbeatMs: 15000,
  replayWindowMs: 120000,
  maxReplayEntries: 256,
  maxQueuedUpdates: 256,
}

/** The slice of DSH Connection this host adapter registers on. */
interface ConnectionService {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['GET']
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** One retained delivery update. */
interface CachedUpdate {
  readonly seq: number
  readonly at: number
  readonly update: NotificationUpdate
}

/** A validated resume cursor. */
interface Cursor {
  readonly epoch: string
  readonly seq: number
}

/** The wire payload sent as the `sync` SSE event. */
interface SyncPayload {
  readonly version: 1
  readonly epoch: string
  readonly seq: number
  readonly reset: boolean
  readonly pending: ApprovalShowUpdate[]
  readonly replay: NotificationUpdate[]
}

/** One live SSE client. */
interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined
  closed: boolean
  queued: number
  readonly pendingFrames: string[]
  readonly heartbeat: NodeJS.Timeout
  send(text: string): void
  close(): void
}

const encoder = new TextEncoder()

/**
 * Encode one named SSE event.
 *
 * @param event - SSE event name.
 * @param data - JSON-serializable payload.
 * @returns the wire frame.
 */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Parse an optional resume cursor. `null` means the query was malformed.
 *
 * @param url - request URL.
 * @returns a cursor, `undefined` for a first connection, or `null` when invalid.
 */
function parseCursor(url: URL): Cursor | undefined | null {
  const epoch = url.searchParams.get('epoch')
  const seqText = url.searchParams.get('seq')
  if (epoch === null && seqText === null) return undefined
  if (epoch === null || seqText === null) return null
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(epoch) || !/^\d+$/u.test(seqText)) return null
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return { epoch, seq }
}

/**
 * Apply the Web adapter.
 *
 * @param ctx - Host context with `agents` and `connection`.
 * @param config - row config merged over {@link DEFAULTS}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  assertTarget(ctx, name)

  const options: Options = { ...DEFAULTS, ...config }
  const triggers: TriggerOptions = {
    notifyOnApproval: options.notifyOnApproval,
    approvalDelayMs: options.approvalDelayMs,
    notifyOnTurnEnd: options.notifyOnTurnEnd,
    notifyOnTurnError: options.notifyOnTurnError,
  }
  const connection = ctx.get('connection') as ConnectionService | undefined
  if (connection === undefined) throw new Error('[notify-web] connection service is unavailable')

  const source = createNotificationSource(ctx, triggers)
  const epoch = randomUUID()
  const heartbeatMs = Number.isFinite(options.heartbeatMs)
    ? Math.max(1000, Math.floor(options.heartbeatMs))
    : DEFAULTS.heartbeatMs
  const replayWindowMs = Number.isFinite(options.replayWindowMs)
    ? Math.max(0, Math.floor(options.replayWindowMs))
    : DEFAULTS.replayWindowMs
  const maxReplayEntries = Number.isFinite(options.maxReplayEntries)
    ? Math.max(0, Math.floor(options.maxReplayEntries))
    : DEFAULTS.maxReplayEntries
  const maxQueuedUpdates = Number.isFinite(options.maxQueuedUpdates)
    ? Math.max(1, Math.floor(options.maxQueuedUpdates))
    : DEFAULTS.maxQueuedUpdates
  let deliverySeq = 0
  const cache = new Map<number, CachedUpdate>()
  const clients = new Set<SseClient>()

  const pruneCache = (): void => {
    const cutoff = Date.now() - replayWindowMs
    for (const [seq, entry] of [...cache]) {
      if (entry.at < cutoff) cache.delete(seq)
    }
    while (cache.size > maxReplayEntries) {
      const first = cache.keys().next()
      if (first.done === true) break
      cache.delete(first.value)
    }
  }

  const broadcast = (update: NotificationUpdate): void => {
    deliverySeq += 1
    const seq = deliverySeq
    const at = Date.now()
    cache.set(seq, { seq, at, update })
    pruneCache()
    const text = frame('update', { type: 'update', seq, update })
    for (const client of [...clients]) client.send(text)
  }

  /**
   * Build the replay payload for one resume cursor. Approval shows that are no
   * longer pending are dropped even when their `withdraw` has already fallen out
   * of the cache, so a reconnect does not briefly resurrect a resolved approval.
   *
   * @param cursor - validated cursor.
   * @param pendingIds - approvals still present in the current snapshot.
   * @returns replay updates and whether the client must reset.
   */
  const replayFor = (
    cursor: Cursor | undefined,
    pendingIds: ReadonlySet<string>,
  ): { reset: boolean; replay: NotificationUpdate[] } => {
    if (cursor === undefined) return { reset: false, replay: [] }
    if (cursor.epoch !== epoch || cursor.seq > deliverySeq) return { reset: true, replay: [] }
    if (cursor.seq === deliverySeq) return { reset: false, replay: [] }
    const cached = [...cache.values()].filter((entry) => entry.seq > cursor.seq).sort((left, right) => left.seq - right.seq)
    if (cached.length === 0) return { reset: true, replay: [] }
    const oldest = Math.min(...cache.keys())
    if (cursor.seq < oldest - 1) return { reset: true, replay: [] }
    const withdrawn = new Set<string>()
    for (const entry of cached) {
      if (entry.update.type === 'withdraw') withdrawn.add(entry.update.id)
    }
    const replay = cached
      .map((entry) => entry.update)
      .filter((update) => {
        if (update.type === 'show' && update.kind === 'approval') {
          return pendingIds.has(update.id) && !withdrawn.has(update.id)
        }
        return true
      })
    return { reset: false, replay }
  }

  /**
   * Open one SSE response.
   *
   * @param request - authenticated Fetch request.
   * @returns the streaming response.
   */
  const openStream = (request: Request): Response => {
    const cursor = parseCursor(new URL(request.url))
    if (cursor === null) return new Response('invalid cursor', { status: 400 })
    // Expiry must also run during idle periods, when no broadcast prunes it.
    pruneCache()
    const pending = source.snapshotPendingApprovals()
    const pendingIds = new Set(pending.map((update) => update.id))
    const { reset, replay } = replayFor(cursor, pendingIds)
    const sync: SyncPayload = {
      version: 1,
      epoch,
      seq: deliverySeq,
      reset,
      pending,
      replay,
    }

    let client: SseClient
    client = {
      controller: undefined,
      closed: false,
      queued: 0,
      pendingFrames: [],
      heartbeat: setInterval(() => client.send(': ping\n\n'), heartbeatMs),
      send(text: string) {
        if (this.closed) return
        if (this.controller === undefined) {
          this.pendingFrames.push(text)
          return
        }
        if (this.queued >= maxQueuedUpdates) {
          this.close()
          return
        }
        try {
          this.controller.enqueue(encoder.encode(text))
          this.queued += 1
        } catch {
          this.close()
        }
      },
      close() {
        if (this.closed) return
        this.closed = true
        clearInterval(this.heartbeat)
        clients.delete(this)
        try {
          this.controller?.close()
        } catch {
          // The peer may already be gone.
        }
      },
    }
    client.heartbeat.unref?.()
    clients.add(client)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client.controller = controller
        for (const text of client.pendingFrames.splice(0)) controller.enqueue(encoder.encode(text))
        client.send(frame('sync', sync))
      },
      pull() {
        client.queued = 0
      },
      cancel() {
        client.close()
      },
    })

    request.signal.addEventListener('abort', () => client.close(), { once: true })
    if (request.signal.aborted) client.close()

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  ctx.effect(() => {
    const unsubscribe = source.subscribe(broadcast)
    const disposeRoute = connection.fetch.register({
      path: '/api/notify-web/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => openStream(request),
    })
    return () => {
      unsubscribe()
      source.dispose()
      for (const client of [...clients]) client.close()
      void disposeRoute()
    }
  }, 'notify-web: notification source and SSE route')
}
