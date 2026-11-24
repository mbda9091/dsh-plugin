// Deterministic model and external child backends, real DSH goal/Agent/subagent
// lifecycle and real authenticated SSE. Never calls an external model.
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export function registerCompletionFixture(ctx) {
  const scenarios = new Map()
  const provider = 'notify-completion-fixture'
  const childProvider = 'notify-completion-child'
  const signal = new AbortController()

  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] } }
    async *stream(options) {
      if (options.purpose) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const state = scenarios.get(options.sessionId)
      if (!state) throw new Error('completion fixture scenario missing')
      const agent = state.handle.agent
      if (state.stage === 'starting') {
        if (state.withGoal) ctx.goals.create(agent, { objective: 'Collect two controlled child results and summarize.', maxGoalRounds: 8 })
        for (let n = 0; n < 2; n++) {
          await ctx.subagents.startActivation({
            provider: childProvider, label: `controlled-${n}`, delivery: 'parent', signal: signal.signal,
            request: { parent: agent, prompt: [{ type: 'text', text: 'Synthetic child work.' }] },
          })
        }
        state.stage = 'waiting'
      } else if (state.children.every(child => child.released)) {
        const goal = ctx.goals.get(agent)
        if (goal?.phase === 'active') ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
        state.stage = 'summarizing'
        await new Promise((resolve, reject) => {
          const abort = () => { cleanup(); reject(new Error('fixture stopped')) }
          const cleanup = () => options.signal.removeEventListener('abort', abort)
          options.signal.addEventListener('abort', abort, { once: true })
          if (options.signal.aborted) abort()
          state.finish.promise.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
        })
        state.stage = 'finished'
      } else state.intermediateRounds++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: state.stage === 'finished' ? 'Both results summarized and verified.' : 'Waiting for remaining child results.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.effect(() => ctx.llm.registerAdapter([provider], new Adapter()))
  ctx.effect(() => ctx.subagents.registerProvider({
    name: childProvider, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start(request) {
      const state = scenarios.get(request.parent.session.id)
      if (!state) throw new Error('completion fixture parent missing')
      const done = Promise.withResolvers()
      const child = {
        id: randomUUID(), released: false,
        release() { this.released = true; done.resolve({ output: [{ type: 'text', text: 'Controlled child finished.' }], stopReason: 'completed' }) },
      }
      state.children.push(child)
      return { id: child.id, result: done.promise, async dispose() { child.release() } }
    },
  }))
  ctx.effect(() => async () => {
    signal.abort()
    for (const state of scenarios.values()) {
      state.finish.resolve()
      for (const child of state.children) child.release()
      await state.handle.dispose()
    }
    scenarios.clear()
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/web-hello/completion', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const body = await request.json()
      let state = scenarios.get(body.sessionId)
      if (body.action === 'start') {
        const handle = await ctx.agents.create({
          sessionId: randomUUID(), meta: { cwd: process.cwd() },
          agentOptions: { provider, model: 'synthetic', maxTokens: 512 },
          setup: scope => { scope.tools.restrict({ allow: [] }) },
        })
        state = { handle, withGoal: body.withGoal !== false, stage: 'starting', children: [], finish: Promise.withResolvers(), intermediateRounds: 0 }
        scenarios.set(handle.agent.session.id, state)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the controlled notification completion scenario.' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      if (!state) return new Response('scenario missing', { status: 404 })
      if (body.action === 'release') state.children[body.index]?.release()
      else if (body.action === 'finish') {
        state.finish.resolve()
        await state.handle.agent.whenIdle()
      } else if (body.action === 'dispose') {
        state.finish.resolve()
        for (const child of state.children) child.release()
        await state.handle.dispose()
        scenarios.delete(body.sessionId)
        return Response.json({ disposed: true })
      } else if (body.action !== 'start' && body.action !== 'state') return new Response('invalid action', { status: 400 })
      return Response.json({
        sessionId: state.handle.agent.session.id, stage: state.stage, status: state.handle.agent.status,
        goal: ctx.goals.get(state.handle.agent)?.phase ?? null,
        remaining: state.children.filter(child => !child.released).length,
        intermediateRounds: state.intermediateRounds,
      })
    },
  }))
}
