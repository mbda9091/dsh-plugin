import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { environment, KEY } from './environment.js'
import type { AttemptView, StatusView } from './protocol.js'

const RETENTION_MS = 15 * 60_000
const MAX_RECEIPTS = 128

/** Only these stable codes cross the wire; native exception messages never do. */
export class LoginError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}

interface PendingPrompt {
  id: string
  accept(value: string): void
  reject(): void
}
interface Attempt {
  view: AttemptView
  controller: AbortController
  timer: NodeJS.Timeout
  done: Promise<void>
  pending?: PendingPrompt
  settledAt?: number
}
interface Receipt {
  operation: string
  at: number
  result: Promise<{ attemptId: string } | { ok: true }>
}

/** In-memory interaction only: durable grants remain exclusively with DSH. */
export class LoginController {
  readonly epoch = randomUUID()
  private revision = 0
  private active?: Attempt
  private disposed = false
  private signingOut = false
  private readonly attempts = new Map<string, Attempt>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly ctx: Context, private readonly timeoutMs: number) {}

  /** Call on public credential/configuration/authorization changes. */
  changed(): void {
    this.revision++
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Reads may await disk; retry when a commit happened during that read. */
  async status(): Promise<StatusView> {
    for (;;) {
      const revision = this.revision
      const record = await this.ctx.get('credentials')?.describeRecord(KEY)
      if (revision !== this.revision) continue
      let state: StatusView['environment']
      try { state = environment(this.ctx) } catch { state = 'configuration-unsupported' }
      return {
        epoch: this.epoch, revision, environment: state,
        credential: !record?.configured ? 'absent' : record.kind === 'grant' ? 'grant' : 'unexpected',
        writable: record?.writable ?? false,
        busy: this.signingOut || !!this.active || !!this.ctx.get('authorization')?.describe(KEY)?.inFlight,
      }
    }
  }

  /** The epoch prevents old requests from mutating a replacement Host instance. */
  checkEpoch(epoch: string): void {
    if (this.disposed || epoch !== this.epoch) throw new LoginError('stale-host')
  }

  /** Retry writes only by their original receipt, including failed operations. */
  once(epoch: string, requestId: string, operation: 'begin' | 'sign-out'): Receipt['result'] {
    this.checkEpoch(epoch)
    const match = /^(\d{13})-([a-f0-9-]{36})$/u.exec(requestId)
    const now = Date.now()
    const timestamp = Number(match?.[1])
    if (!match || timestamp > now + 30_000 || timestamp <= now - RETENTION_MS) throw new LoginError('expired-request', 400)
    for (const [key, receipt] of this.receipts) if (receipt.at <= now - RETENTION_MS) this.receipts.delete(key)
    for (const [key, attempt] of this.attempts) {
      if (attempt.settledAt !== undefined && attempt.settledAt <= now - RETENTION_MS) this.attempts.delete(key)
    }
    const old = this.receipts.get(requestId)
    if (old) {
      if (old.operation !== operation) throw new LoginError('request-conflict')
      return old.result
    }
    if (this.receipts.size >= MAX_RECEIPTS) throw new LoginError('too-many-attempts', 429)
    // Defer execution until the receipt is registered, before any native flow runs.
    const result: Receipt['result'] = Promise.resolve().then(async () => operation === 'begin' ? this.begin() : this.signOut())
    this.receipts.set(requestId, { operation, at: timestamp, result })
    return result
  }

  private begin(): { attemptId: string } {
    if (this.disposed) throw new LoginError('stale-host')
    if (this.active || this.signingOut) throw new LoginError('busy')
    const state = environment(this.ctx)
    if (state !== 'ready') throw new LoginError(state)
    const auth = this.ctx.get('authorization')!
    if (auth.describe(KEY)?.inFlight) throw new LoginError('busy')
    const controller = new AbortController()
    const attemptId = randomUUID()
    const attempt: Attempt = {
      view: { epoch: this.epoch, revision: this.revision, attemptId, state: 'running', deadline: Date.now() + this.timeoutMs },
      controller,
      timer: setTimeout(() => controller.abort(), this.timeoutMs),
      done: Promise.resolve(),
    }
    attempt.timer.unref()
    this.active = attempt
    this.attempts.set(attemptId, attempt)
    this.changed()
    attempt.done = this.run(attempt)
    return { attemptId }
  }

  private async run(attempt: Attempt): Promise<void> {
    try {
      const result = await this.ctx.get('authorization')!.begin({
        key: KEY, method: 'oauth', signal: attempt.controller.signal,
        interaction: {
          notify: notice => {
            if (this.active !== attempt || attempt.controller.signal.aborted) return
            // A later progress notice must not leave an obsolete device code/link visible.
            attempt.view.notice = { message: notice.message, ...(notice.code ? { code: notice.code } : {}),
              ...(safeUrl(notice.url) ? { url: safeUrl(notice.url) } : {}) }
            this.changed()
          },
          prompt: prompt => this.prompt(attempt, prompt),
        },
      })
      attempt.view.state = result.status
    } catch {
      attempt.view.state = attempt.controller.signal.aborted ? 'cancelled' : 'failed'
      if (attempt.view.state === 'failed') attempt.view.error = 'authorization-failed'
    } finally {
      clearTimeout(attempt.timer)
      const state = attempt.view.state
      attempt.pending?.reject()
      attempt.view.state = state
      delete attempt.pending
      delete attempt.view.prompt
      delete attempt.view.notice
      attempt.settledAt = Date.now()
      if (this.active === attempt) this.active = undefined
      this.changed()
    }
  }

  private prompt(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    if (this.active !== attempt || attempt.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(new Error('prompt withdrawn'))
    }
    attempt.pending?.reject()
    const { signal, ...wire } = prompt
    const id = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const settle = (value?: string): void => {
        if (attempt.pending?.id !== id) return
        signal?.removeEventListener('abort', withdraw)
        attempt.controller.signal.removeEventListener('abort', withdraw)
        delete attempt.pending
        delete attempt.view.prompt
        if (this.active === attempt) attempt.view.state = 'running'
        this.changed()
        if (value === undefined) reject(new Error('prompt withdrawn'))
        else resolve(value)
      }
      const withdraw = (): void => settle()
      attempt.pending = { id, accept: value => settle(value), reject: withdraw }
      attempt.view.prompt = { ...wire, id }
      attempt.view.state = 'waiting'
      signal?.addEventListener('abort', withdraw, { once: true })
      attempt.controller.signal.addEventListener('abort', withdraw, { once: true })
      this.changed()
    })
  }

  /** Possession of the unpredictable attempt id is required for private prompts. */
  view(epoch: string, attemptId: string): AttemptView {
    this.checkEpoch(epoch)
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new LoginError('attempt-missing', 404)
    return { ...attempt.view, revision: this.revision }
  }

  answer(epoch: string, attemptId: string, promptId: string, value: string): void {
    const view = this.view(epoch, attemptId)
    const attempt = this.attempts.get(attemptId)!
    if (attempt !== this.active || view.prompt?.id !== promptId || !attempt.pending) throw new LoginError('prompt-expired')
    if (!value.trim() || value.length > 16_384) throw new LoginError('invalid-answer', 400)
    if (view.prompt.kind === 'select' && !view.prompt.options.some(option => option.id === value)) throw new LoginError('invalid-answer', 400)
    attempt.pending.accept(value)
  }

  async cancel(epoch: string, attemptId: string): Promise<void> {
    this.view(epoch, attemptId)
    const attempt = this.attempts.get(attemptId)!
    if (attempt === this.active) {
      attempt.controller.abort()
      await attempt.done
    }
  }

  private async signOut(): Promise<{ ok: true }> {
    if (this.disposed) throw new LoginError('stale-host')
    if (this.signingOut) throw new LoginError('busy')
    this.signingOut = true
    this.changed()
    try {
      if (this.active) await this.cancel(this.epoch, this.active.view.attemptId)
      if (this.ctx.get('authorization')?.describe(KEY)?.inFlight) throw new LoginError('busy')
      const credentials = this.ctx.get('credentials')
      if (!credentials) throw new LoginError('services-missing')
      await credentials.deleteRecord(KEY)
      if ((await credentials.describeRecord(KEY)).configured) throw new LoginError('sign-out-failed')
      return { ok: true }
    } finally {
      this.signingOut = false
      this.changed()
    }
  }

  dispose(): void {
    this.disposed = true
    this.active?.controller.abort()
    this.active?.pending?.reject()
    if (this.active) clearTimeout(this.active.timer)
    this.listeners.clear()
    this.receipts.clear()
    this.attempts.clear()
  }
}

/** Native messages render as text; only http(s) links may be opened. */
export function safeUrl(input?: string): string | undefined {
  if (!input) return undefined
  try {
    const url = new URL(input)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
