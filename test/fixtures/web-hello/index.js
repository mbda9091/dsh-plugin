import { randomUUID } from 'node:crypto'

export const name = 'web-hello'
export const inject = ['connection', 'sessions']

// Test-only authenticated endpoint: proves a UI interaction reaches the Host.
export function apply(ctx) {
  const seeded = new Set()
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/web-hello/seed', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const { sessionId } = await request.json()
      const session = ctx.sessions.get(sessionId)
      if (!session) return new Response('session missing', { status: 404 })
      if (seeded.has(sessionId)) return Response.json({ ok: true })
      // A durable supported event makes the conversation nonblank without a model call.
      session.append('turn/start', { turn: 0 })
      session.append('user/message', {
        id: randomUUID(), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'L5 fixture session' }],
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 0, reason: { kind: 'blocked' } })
      seeded.add(sessionId)
      return Response.json({ ok: true })
    },
  }))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/web-hello/notify', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const { sessionId, action } = await request.json()
      const session = seeded.has(sessionId) ? ctx.sessions.get(sessionId) : undefined
      if (!session) return new Response('fixture session required', { status: 404 })
      if (action === 'approval') {
        session.append('approval/asked', { id: 'l5-approval', toolName: 'shell-test', reason: 'L5 test' })
      } else if (action === 'complete') {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      } else if (action === 'withdraw') {
        session.append('approval/decided', { id: 'l5-approval', outcome: 'rejected' })
      } else return new Response('invalid action', { status: 400 })
      return Response.json({ ok: true })
    },
  }))
  let count = 0
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/web-hello/echo',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const { text } = await request.json()
      if (typeof text !== 'string') return new Response('text required', { status: 400 })
      return Response.json({ text, count: ++count })
    },
  }))
}
