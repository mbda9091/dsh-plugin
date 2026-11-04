import { randomUUID } from 'node:crypto'

export const name = 'web-hello'
export const inject = ['connection', 'sessions']

// Test-only authenticated endpoint: proves a UI interaction reaches the Host.
export function apply(ctx) {
  const seeded = new Set()
  const turns = new Map()
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
      } else if (action === 'question') {
        const turn = (turns.get(sessionId) ?? 0) + 1
        turns.set(sessionId, turn)
        session.append('turn/start', { turn })
        session.append('tool/call', { turn, step: 0, callId: 'l5-question', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'choice', question: 'Which option?' }] }) })
      } else if (action === 'answer') {
        const turn = turns.get(sessionId)
        session.append('tool/result', { turn, step: 0, message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId: 'l5-question' }, toolCallId: 'l5-question', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'choice', selected: ['A'] }] }) }] } }, { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'blocked' } })
      } else if (action === 'complete') {
        const turn = (turns.get(sessionId) ?? 0) + 1
        turns.set(sessionId, turn)
        session.append('turn/start', { turn })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
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
