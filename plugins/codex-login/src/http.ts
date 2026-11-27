import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { LoginController, LoginError } from './controller.js'

/** Strict request shape: the caller can never choose a credential key. */
async function body(request: Request, required: string[]): Promise<Record<string, string>> {
  let value: unknown
  try { value = await request.json() } catch { throw new LoginError('invalid-request', 400) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LoginError('invalid-request', 400)
  if (Object.keys(value).some(key => !required.includes(key))) throw new LoginError('invalid-request', 400)
  const result: Record<string, string> = {}
  for (const key of required) {
    const entry: unknown = Reflect.get(value, key)
    if (typeof entry !== 'string' || entry.length > 16_384 || !entry) throw new LoginError('invalid-request', 400)
    result[key] = entry
  }
  return result
}

/** Register exact routes behind the existing Connection trust/owner gate. */
export function registerRoutes(ctx: Context, controller: LoginController): () => Promise<void> {
  const streams = new Set<() => void>()
  const disposers: Array<() => Promise<void>> = []
  const connection = ctx.get('connection')!
  const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
  const route = (operation: string, method: 'GET' | 'POST', fetch: (request: Request) => Promise<Response>): void => {
    disposers.push(connection.fetch.register({
      path: `/api/codex-login/${operation}`, methods: [method], requestBody: 'buffered',
      async fetch(request) {
        try { return await fetch(request) } catch (error) {
          return json({ error: error instanceof LoginError ? error.code : 'operation-failed' }, error instanceof LoginError ? error.status : 500)
        }
      },
    }))
  }
  route('status', 'GET', async () => json(await controller.status()))
  for (const operation of ['begin', 'sign-out'] as const) route(operation, 'POST', async request => {
    const data = await body(request, ['epoch', 'requestId'])
    return json(await controller.once(data.epoch!, data.requestId!, operation))
  })
  route('answer', 'POST', async request => {
    const data = await body(request, ['epoch', 'attemptId', 'promptId', 'value'])
    controller.answer(data.epoch!, data.attemptId!, data.promptId!, data.value!)
    return json({ ok: true })
  })
  route('cancel', 'POST', async request => {
    const data = await body(request, ['epoch', 'attemptId'])
    await controller.cancel(data.epoch!, data.attemptId!)
    return json({ ok: true })
  })
  route('events', 'GET', async request => {
    const url = new URL(request.url)
    const epoch = url.searchParams.get('epoch') ?? ''
    const id = url.searchParams.get('attemptId')
    controller.checkEpoch(epoch)
    if (id) controller.view(epoch, id)
    const encoder = new TextEncoder()
    let close = (): void => {}
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        let closed = false
        const send = (): void => {
          if (closed) return
          try {
            if ((output.desiredSize ?? 0) < -8) { close(); return }
            const data = id ? controller.view(epoch, id) : { epoch, changed: true }
            output.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(data)}\n\n`))
          } catch { close() }
        }
        const unsubscribe = controller.subscribe(send)
        const heartbeat = setInterval(() => {
          if ((output.desiredSize ?? 0) < -8) close()
          else if (!closed) output.enqueue(encoder.encode(': ping\n\n'))
        }, 15_000)
        heartbeat.unref()
        close = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          request.signal.removeEventListener('abort', close)
          streams.delete(close)
          try { output.close() } catch { /* peer already closed */ }
        }
        streams.add(close)
        request.signal.addEventListener('abort', close, { once: true })
        if (request.signal.aborted) close()
        else send() // Subscribe and snapshot in one synchronous turn: no lost baseline event.
      },
      cancel() { close() },
    })
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no',
    } })
  })
  return async () => {
    for (const close of streams) close()
    await Promise.all(disposers.map(dispose => dispose()))
  }
}
