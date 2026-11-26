import { randomUUID } from 'node:crypto'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply as applyAskUser } from '@deepseek-ai/dsh-tool-ask-user'
import { registerCompletionFixture } from './completion.js'

export const name = 'web-hello'
export const inject = ['connection', 'sessions', 'agents', 'llm', 'goals', 'subagents']

// Test-only authenticated endpoint: proves a UI interaction reaches the Host.
export function apply(ctx) {
  registerCompletionFixture(ctx)
  const seeded = new Set()
  const questions = new Map()
  // Hold forwarding at the Host boundary, then delegate to the real Client card.
  ctx.on('user-questions/request', async (request, next) => {
    const pending = questions.get(request.agent?.session.id)
    if (!pending) return next()
    pending.started()
    const abort = () => pending.release()
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    try { await pending.gate; return await next() } finally { request.signal?.removeEventListener('abort', abort) }
  }, { global: true, prepend: true })
  ctx.effect(() => () => {
    for (const pending of questions.values()) pending.controller.abort()
    questions.clear()
  })
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
      if (action === 'question' || action === 'question-ptc' || action === 'question-timed') {
        if (questions.has(sessionId)) return new Response('question already running', { status: 409 })
        const agent = ctx.agents.list().find(agent => agent.session === session && ctx.subagents.rootOf(agent) === agent)
        if (!agent) return new Response('root missing', { status: 404 })
        const controller = new AbortController()
        let release, started
        const gate = new Promise(resolve => { release = resolve })
        const ready = new Promise(resolve => { started = resolve })
        const pending = { gate, release, started, controller }
        questions.set(sessionId, pending)
        // The executor commits tool/call and tool/result; no synthetic notification intent.
        try {
          if (action === 'question-timed') await agent.ctx.inject(['tools', 'userQuestions'], scope => applyAskUser(scope, { mode: 'timed', timeout: -1 }))
          const args = { questions: [{ id: 'q', question: 'Which option should we use?', options: [{ label: 'A' }, { label: 'B' }] }] }
          const executor = action === 'question-ptc' ? new PtcExecutor(agent.ctx) : agent.ctx.tools
          pending.execution = executor.execute({
            agent, signal: controller.signal, log: { turn: 2, step: 1 },
            calls: [{ type: 'tool-call', id: `l5-question-${randomUUID()}`,
              name: action === 'question-ptc' ? 'run_code' : 'ask_user_question',
              arguments: JSON.stringify(action === 'question-ptc'
                ? { code: `await tools.ask_user_question(${JSON.stringify(args)})`, description: 'L5 controlled user question' }
                : args) }],
          })
          await Promise.race([ready, pending.execution.then(result => { throw new Error(`ask tool did not reach the answerer: ${JSON.stringify(result)}`) })])
        } catch (error) {
          questions.delete(sessionId)
          return Response.json({ error: String(error) }, { status: 500 })
        }
      } else if (action === 'question-release') {
        const pending = questions.get(sessionId)
        if (!pending) return new Response('question missing', { status: 404 })
        pending.release()
      } else if (action === 'answer') {
        const pending = questions.get(sessionId)
        if (!pending) return new Response('question missing', { status: 404 })
        await pending.execution
        questions.delete(sessionId)
      } else if (action === 'approval') {
        session.append('approval/asked', { id: 'l5-approval', toolName: 'shell-test', reason: 'L5 test' })
      } else if (action === 'complete' || action === 'max-tokens') {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: action === 'complete' ? 'completed' : 'max-tokens' } })
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
