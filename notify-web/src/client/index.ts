/**
 * Browser entry for `@local/notify-web`.
 *
 * The Host owns all trigger decisions and publishes serializable updates on an
 * authenticated SSE route. This page consumes that stream, formats copy with the
 * active Client locale, shows or withdraws OS notifications, and focuses its own
 * tab when one is clicked.
 *
 * Multi-tab delivery uses Web Locks to elect one leader. The leader owns the
 * SSE stream and notifications; other tabs wait for the lock. Without Web Locks
 * every tab consumes independently and stable notification tags reduce
 * duplicates.
 */
import {
  approvalContent,
  fallbackTranslate,
  turnEndContent,
  zh,
  en,
} from '@local/notify-core'
import type { NotificationContent, Translate, TurnEndReason } from '@local/notify-core'
import type { ApprovalShowUpdate, NotificationUpdate } from '@local/notify-host'

/** Client locale namespace owned by this plugin. */
const NS = 'notify-web'
/** Maximum remembered notification ids; older ids may be re-shown after a replay. */
const SEEN_LIMIT = 512
/** Seen ids older than this are dropped from browser storage. */
const SEEN_TTL_MS = 10 * 60_000
/** Retry bounds for the SSE consumer. */
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000
/** A sustained connection resets backoff; a short 200/EOF response does not. */
const RETRY_STABLE_MS = 30_000
/** 401/403 means the browser auth is not usable yet; poll slowly. */
const AUTH_RETRY_MS = 30_000

/** The browser module-loader entry shape used by the Web shell. */
interface DshClientModuleLoader {
  load(entry: {
    readonly id: string
    factory(require: (name: string) => unknown): DshClientPlugin
  }): void
}

/** The slice of the Client plugin face this module implements. */
interface DshClientPlugin {
  readonly inject: readonly string[]
  apply(ctx: DshClientContext): void
}

/** The Client context surface used here; services are looked up by name. */
interface DshClientContext {
  get(name: string): unknown
  effect?(callback: () => () => void, label?: string): () => void
}

/** The Workspace navigation service as consumed here. */
interface UiWorkspaceService {
  openSession(sessionId: string): void
}

/** The Client locale service as consumed here. */
interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string, params?: Record<string, string>) => string
}

/** The `sync` payload sent by the Host. */
interface SyncPayload {
  readonly version?: number
  readonly epoch?: string
  readonly seq?: number
  readonly reset?: boolean
  readonly pending?: readonly ApprovalShowUpdate[]
  readonly replay?: readonly NotificationUpdate[]
}

/** The `update` payload sent by the Host. */
interface UpdatePayload {
  readonly version?: number
  readonly seq?: number
  readonly update?: NotificationUpdate
}

/** A validated resume cursor. */
interface Cursor {
  readonly epoch: string
  readonly seq: number
}

/** Widen the global object with the shell markers this module probes. */
declare global {
  interface Window {
    readonly __ModuleLoader__: DshClientModuleLoader
    readonly dshDesktopBoot?: unknown
    readonly __DSH_TRANSPORT__?: { readonly ownsHost?: boolean }
  }
}

/**
 * Whether this page is the Desktop shell's embedded Web UI. The Desktop host
 * already has its native toast.
 *
 * @returns `true` when the Host half owns notifications.
 */
function isDesktopShell(): boolean {
  const scope = globalThis as typeof globalThis & {
    dshDesktopBoot?: unknown
    __DSH_TRANSPORT__?: { readonly ownsHost?: boolean }
  }
  return scope.dshDesktopBoot !== undefined
    || (scope.__DSH_TRANSPORT__ !== undefined && scope.__DSH_TRANSPORT__.ownsHost === true)
}

/**
 * Read the browser's notification permission.
 *
 * @returns the permission, or `'unsupported'`.
 */
function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return Notification.permission
  } catch {
    return 'denied'
  }
}

/**
 * Sleep until the delay expires or the signal aborts.
 *
 * @param delay - milliseconds.
 * @param signal - abort signal.
 * @returns a promise resolved on expiry or abort.
 */
function sleep(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, delay)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Build a random jittered retry delay.
 *
 * @param base - current backoff.
 * @returns delay with up to 25% jitter.
 */
function jitter(base: number): number {
  return base + Math.floor(Math.random() * base * 0.25)
}

/**
 * Extract one notification id's family from its stable identity.
 *
 * @param id - notification id.
 * @returns `'approval'`, `'turn-end'`, or `undefined`.
 */
function idKind(id: string): 'approval' | 'turn-end' | undefined {
  if (id.includes(':approval:')) return 'approval'
  if (id.includes(':turn-end:')) return 'turn-end'
  return undefined
}

/**
 * Register the SSE consumer, locale copy, permission flow, and notification UI.
 *
 * @param uiWorkspace - Workspace navigation used by notification clicks.
 * @param locale - Client locale registry, when present.
 * @returns disposer for every listener, stream, and notification.
 */
function install(uiWorkspace: UiWorkspaceService, locale: LocaleService | undefined): () => void {
  const disposers: Array<() => void> = []
  const add = (dispose: (() => void) | undefined): void => {
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const t: Translate = locale === undefined || typeof locale.bind !== 'function'
    ? fallbackTranslate('zh')
    : (key, params) => locale.bind(NS)(key, params)
  if (locale !== undefined && typeof locale.register === 'function') {
    add(locale.register(NS, { zh, en }))
  }

  const base = new URL('.', document.baseURI)
  const endpoint = new URL('api/notify-web/events', base)
  const storageKey = `notify-web:cursor:${base.pathname}`
  const seenKey = `notify-web:seen:${base.pathname}`
  const lockName = `notify-web:${base.pathname}`

  /**
   * Load the bounded, expiring set of notification ids another leader may have
   * shown. Cursor replay already covers the normal path; this only narrows the
   * crash window between `new Notification()` and saving the cursor.
   */
  const loadSeen = (): Map<string, number> => {
    const result = new Map<string, number>()
    try {
      const raw = localStorage.getItem(seenKey)
      if (raw === null) return result
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return result
      const cutoff = Date.now() - SEEN_TTL_MS
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue
        const id = (entry as { id?: unknown }).id
        const at = (entry as { at?: unknown }).at
        if (typeof id !== 'string' || typeof at !== 'number' || at < cutoff) continue
        result.set(id, at)
      }
    } catch {
      // Storage can be unavailable; memory-only dedupe still applies.
    }
    return result
  }

  /** Notifications currently on screen, keyed by Host notification id. */
  const shown = new Map<string, Notification>()
  /** Ids already shown; bounded to avoid replaying very old messages. */
  const seen = loadSeen()
  /** Latest turn-end notification per Session. */
  const turnEndBySession = new Map<string, string>()
  let currentEpoch: string | undefined
  let cursor: Cursor | undefined
  /** Restore pending notifications once per page activation/leader tenure. */
  let restorePending = true
  let disposed = false
  let leaderAbort: AbortController | undefined

  const saveSeen = (): void => {
    const cutoff = Date.now() - SEEN_TTL_MS
    for (const [id, at] of [...seen]) {
      if (at < cutoff) seen.delete(id)
    }
    while (seen.size > SEEN_LIMIT) {
      const first = seen.keys().next()
      if (first.done === true) break
      seen.delete(first.value)
    }
    try {
      localStorage.setItem(seenKey, JSON.stringify([...seen].map(([id, at]) => ({ id, at }))))
    } catch {
      // Storage can be unavailable; memory-only dedupe still applies.
    }
  }

  const remember = (id: string): void => {
    seen.set(id, Date.now())
    saveSeen()
  }

  const loadCursor = (): Cursor | undefined => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw === null) return undefined
      const value = JSON.parse(raw) as { epoch?: unknown; seq?: unknown }
      if (typeof value.epoch !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(value.epoch)) return undefined
      if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) return undefined
      return { epoch: value.epoch, seq: value.seq }
    } catch {
      return undefined
    }
  }

  const saveCursor = (next: Cursor): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Storage can be unavailable (private mode/quota); the stream still works.
    }
  }

  const closeNotification = (id: string): void => {
    const notification = shown.get(id)
    if (notification === undefined) return
    shown.delete(id)
    for (const [sessionId, value] of turnEndBySession) {
      if (value === id) turnEndBySession.delete(sessionId)
    }
    try {
      notification.close()
    } catch {
      // The peer may already be gone.
    }
  }

  const closeAll = (): void => {
    for (const id of [...shown.keys()]) closeNotification(id)
    turnEndBySession.clear()
  }

  const show = (id: string, tag: string, content: NotificationContent, sessionId: string, force = false): void => {
    if (notificationPermission() !== 'granted' || shown.has(id) || (!force && seen.has(id))) return
    let notification: Notification
    try {
      notification = new Notification(content.title, {
        body: content.body,
        tag,
        requireInteraction: true,
      })
    } catch (error) {
      console.warn('[notify-web] cannot show the browser notification:', error)
      return
    }
    notification.onclick = () => {
      closeNotification(id)
      try {
        notification.close()
      } catch {
        // Already gone.
      }
      try {
        window.focus()
      } catch {
        // Focus is best effort; the Session switch still happens.
      }
      try {
        uiWorkspace.openSession(sessionId)
      } catch (error) {
        console.warn('[notify-web] cannot open the notification session:', error)
      }
    }
    notification.onclose = () => {
      shown.delete(id)
    }
    notification.onerror = () => {
      shown.delete(id)
    }
    shown.set(id, notification)
    remember(id)
  }

  const showApproval = (update: ApprovalShowUpdate, force = false): void => {
    const content = approvalContent({ toolName: update.toolName, reason: update.reason }, t)
    show(update.id, `dsh-approval:${update.id}`, content, update.sessionId, force)
  }

  const showTurnEnd = (update: NotificationUpdate & { type: 'show'; kind: 'turn-end' }): void => {
    const reason: TurnEndReason = update.errorMessage === undefined
      ? { kind: update.reasonKind }
      : { kind: update.reasonKind, error: { message: update.errorMessage } }
    const content = turnEndContent(reason, t)
    if (content === undefined) return
    const previous = turnEndBySession.get(update.sessionId)
    if (previous !== undefined) closeNotification(previous)
    show(update.id, `dsh-turn-end:${update.id}`, content, update.sessionId)
    if (shown.has(update.id)) turnEndBySession.set(update.sessionId, update.id)
  }

  const applyUpdate = (update: NotificationUpdate): void => {
    if (update.type === 'withdraw') {
      closeNotification(update.id)
      return
    }
    if (update.kind === 'approval') showApproval(update)
    else showTurnEnd(update)
  }

  const applySync = (payload: SyncPayload): void => {
    const epochChanged = currentEpoch !== undefined && payload.epoch !== currentEpoch
    const reset = payload.reset === true || epochChanged
    if (reset) {
      closeAll()
      seen.clear()
      try {
        localStorage.removeItem(seenKey)
      } catch {
        // Storage can be unavailable.
      }
    }
    if (typeof payload.epoch !== 'string') return
    currentEpoch = payload.epoch
    const pending = new Map<string, ApprovalShowUpdate>()
    for (const update of payload.pending ?? []) {
      if (typeof update.id !== 'string' || typeof update.sessionId !== 'string') continue
      pending.set(update.id, update)
      showApproval(update, restorePending)
    }
    for (const id of [...shown.keys()]) {
      if (idKind(id) === 'approval' && !pending.has(id)) closeNotification(id)
    }
    for (const update of payload.replay ?? []) applyUpdate(update)
    restorePending = false
    if (typeof payload.seq === 'number' && Number.isSafeInteger(payload.seq) && payload.seq >= 0) {
      cursor = { epoch: payload.epoch, seq: payload.seq }
      saveCursor(cursor)
    }
  }

  const applyUpdatePayload = (payload: UpdatePayload): void => {
    if (payload.update === undefined || typeof payload.seq !== 'number' || !Number.isSafeInteger(payload.seq)) return
    applyUpdate(payload.update)
    if (currentEpoch !== undefined) {
      cursor = { epoch: currentEpoch, seq: payload.seq }
      saveCursor(cursor)
    }
  }

  const handleFrame = (frame: string): void => {
    let event = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    if (event === 'sync') applySync(parsed as SyncPayload)
    else if (event === 'update') applyUpdatePayload(parsed as UpdatePayload)
  }

  const readStream = async (body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          handleFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  const connectOnce = async (signal: AbortSignal): Promise<void> => {
    const url = new URL(endpoint)
    if (cursor !== undefined) {
      url.searchParams.set('epoch', cursor.epoch)
      url.searchParams.set('seq', String(cursor.seq))
    }
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok) {
      const error = new Error(`notify-web stream failed: ${response.status}`) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    if (response.body === null) throw new Error('notify-web stream has no body')
    await readStream(response.body, signal)
  }

  const consumeLoop = async (signal: AbortSignal): Promise<void> => {
    let backoff = RETRY_BASE_MS
    while (!signal.aborted) {
      const startedAt = Date.now()
      let status: number | undefined
      try {
        await connectOnce(signal)
      } catch (error) {
        status = (error as { status?: number }).status
      }
      if (signal.aborted) break
      if (Date.now() - startedAt >= RETRY_STABLE_MS) backoff = RETRY_BASE_MS
      const authFailure = status === 401 || status === 403
      const delay = authFailure ? AUTH_RETRY_MS : Math.min(RETRY_MAX_MS, jitter(backoff))
      if (!authFailure) backoff = Math.min(RETRY_MAX_MS, backoff * 2)
      // A clean EOF still requires retry pacing, just like a network error.
      await sleep(delay, signal)
    }
  }

  const startLeader = (): void => {
    if (disposed || leaderAbort !== undefined || notificationPermission() !== 'granted') return
    const controller = new AbortController()
    leaderAbort = controller
    const run = async (): Promise<void> => {
      if (controller.signal.aborted) return
      // Read shared state only when taking over, never over an active stream's
      // newer in-memory cursor (storage may be blocked or writes may fail).
      const stored = loadCursor()
      if (stored !== undefined && (cursor === undefined || stored.epoch !== cursor.epoch || stored.seq > cursor.seq)) {
        cursor = stored
      }
      restorePending = true
      await consumeLoop(controller.signal)
    }
    const locks = (navigator as Navigator & {
      locks?: {
        request(
          name: string,
          options: { mode: 'exclusive' },
          callback: () => Promise<void>,
        ): Promise<void>
      }
    }).locks
    if (locks === undefined) {
      void run()
      return
    }
    void locks.request(lockName, { mode: 'exclusive' }, run).catch((error) => {
      console.warn('[notify-web] notification lock failed; consuming without the lock:', error)
      if (!controller.signal.aborted) void run()
    })
  }

  const removeGesture = (): void => {
    window.removeEventListener('pointerdown', onGesture, true)
    window.removeEventListener('keydown', onGesture, true)
  }
  const requestPermission = async (retryOnGesture: boolean): Promise<void> => {
    if (notificationPermission() !== 'default') {
      startLeader()
      return
    }
    try {
      await Notification.requestPermission()
    } catch (error) {
      console.warn('[notify-web] cannot request notification permission:', error)
    }
    if (disposed) return
    if (retryOnGesture && notificationPermission() === 'default') {
      // Some browsers require user activation. Arm one fallback only after the
      // initial request settles, so interactions cannot open concurrent prompts.
      window.addEventListener('pointerdown', onGesture, true)
      window.addEventListener('keydown', onGesture, true)
    }
    startLeader()
  }
  const onGesture = (): void => {
    removeGesture()
    void requestPermission(false)
  }
  add(removeGesture)

  // Request at plugin activation, before any notification event or interaction.
  // A persistent denial must be changed in browser settings; do not re-prompt.
  void requestPermission(true)

  const onPageHide = (): void => {
    leaderAbort?.abort()
    leaderAbort = undefined
    closeAll()
  }
  const onPageShow = (): void => {
    if (notificationPermission() === 'granted') startLeader()
  }
  const onFocus = (): void => {
    if (notificationPermission() === 'granted') startLeader()
  }
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('focus', onFocus)
  add(() => {
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('focus', onFocus)
  })

  add(() => {
    disposed = true
    leaderAbort?.abort()
    leaderAbort = undefined
    closeAll()
    seen.clear()
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Disposal is best effort.
      }
    }
    disposers.length = 0
  }
}

window.__ModuleLoader__.load({
  id: '@local/notify-web',
  factory(_require: (name: string) => unknown): DshClientPlugin {
    return {
      inject: ['uiWorkspace', 'locale'],
      apply(ctx) {
        if (isDesktopShell()) return
        if (typeof Notification === 'undefined') {
          console.info('[notify-web] this browser has no Notification API; browser notifications are off')
          return
        }
        const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspaceService | undefined
        if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
          console.warn('[notify-web] uiWorkspace is unavailable; browser notifications are off')
          return
        }
        const locale = ctx.get('locale') as LocaleService | undefined
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => install(uiWorkspace, locale), 'notify-web: SSE notification consumer')
          return
        }
        install(uiWorkspace, locale)
      },
    }
  },
})
