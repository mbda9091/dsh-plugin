// Test-only authenticated route. Uses actual DSH Agents, scopes and tool admission.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { checkM5, registerM5Providers } from './m5.js'
import { registerLive } from './live.js'
export const name = 'role-agent-contract'
export const inject = ['roleAgent', 'agents', 'agentPresets', 'systemPrompt', 'tools', 'connection', 'llm', 'sessionPersistence', 'sessions', 'commands', 'web', 'permissionPresets', 'jobs', 'schedule', 'goals']
export function apply(ctx, config = {}) {
  if (config.m5Proof === true) registerM5Providers(ctx)
  if (config.live === true) registerLive(ctx, config)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/role-agent-contract', methods: ['POST'], requestBody: 'buffered',
    async fetch() {
      const handles = []
      const requests = []
      class ContractAdapter extends LlmAdapter {
        async *stream(options) {
          requests.push(options)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '合成回应，仅用于验证宿主协议。' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成回应，仅用于验证宿主协议。' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      const unregister = ctx.llm.registerAdapter(['role-contract'], new ContractAdapter())
      const signal = AbortSignal.timeout(90000)
      const create = async (preset, meta = {}, route = { provider: 'role-contract', model: 'synthetic' }) => {
        const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd(), agentPreset: preset, ...meta }, agentOptions: route,
          setup: async scope => { await ctx.agentPresets.mount(scope, preset) }, signal })
        handles.push(handle); return handle.agent
      }
      const inspect = async agent => {
        const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'contract-no-model', model: 'no-call' }, signal })
        try {
          const names = [...toolSet.view(agent).keys()]
          const assembly = await ctx.systemPrompt.assemble({ ...assembleContextFor(agent, signal), toolSet })
          return { names, schemas: Object.fromEntries([...toolSet.view(agent)].map(([name,t])=>[name,t.parameters])), sections: assembly.sections.map(s => s.text).join('\n'), context: assembly.contexts.map(c => c.text).join('\n') }
        } finally { toolSet.dispose() }
      }
      try {
        const before = ctx.roleAgent.inspect()
        const ordinary = await create('standard')
        const normalBefore = await inspect(ordinary)
        assert.equal(normalBefore.names.some(n => n.startsWith('role_')), false)
        await ctx.agentPresets.select(ordinary, 'role-lan')
        assert.ok((await inspect(ordinary)).names.includes('role_recall'))
        await ctx.agentPresets.select(ordinary, 'standard')
        assert.deepEqual(await inspect(ordinary), normalBefore)
        await ctx.roleAgent.retry()
        const role = await create('role-lan')
        const state = await inspect(role)
        assert.ok(state.sections.includes('你是岚'))
        assert.ok(state.context.includes('characterId'))
        for (const tool of ['role_recall', 'role_read_sources', 'role_correct', 'role_note_feedback']) assert.ok(state.names.includes(tool), tool)
        const admittedTools = await ctx.tools.resolve({ agent: role, modelSelection: { provider: 'contract-no-model', model: 'no-call' }, signal })
        try {
          const result = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID(), name: 'role_recall', arguments: JSON.stringify({ query: '答应了却没来' }) }], signal, agent: role, toolSet: admittedTools })
          assert.equal(result.results[0].result.isError, true)
          assert.ok(result.results[0].result.content.some(b => b.type === 'text' && b.text.includes('not configured')))
        } finally { admittedTools.dispose() }
        const sub = await create('role-lan', { origin: 'subagent' })
        const subState = await inspect(sub)
        assert.equal(subState.names.some(n => n.startsWith('role_')), false)
        assert.equal(subState.sections.includes('你是岚'), false)
        assert.equal(subState.context.includes('characterId'), false)
        const normalAfter = await inspect(ordinary)
        assert.deepEqual(normalAfter, normalBefore)
        const after = ctx.roleAgent.inspect()
        assert.equal(after.boundSessions, before.boundSessions + 1)
        assert.equal(after.memoryConfigured, false)
        assert.equal(role.session.deriveMessages().length, 0)
        for (const text of ['第一轮合成消息', '第二轮合成消息']) {
          role.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
          await role.whenIdle()
        }
        const conversationRequests = requests.filter(r => r.sessionId === role.session.id && !r.purpose)
        assert.equal(conversationRequests.length, 2, JSON.stringify(requests.map(r => ({ sessionId: r.sessionId, purpose: r.purpose }))))
        assert.ok(conversationRequests.every(r => r.messages.some(m => m.role === 'user' && m.source?.kind === 'runtime-context')))
        assert.ok(await ctx.sessions.flush(role.session))
        const reader = await ctx.sessionPersistence.open(role.session.id, 'read')
        try {
          const { events } = await reader.read()
          assert.equal(events.filter(e => e.type === 'user/message' && e.data.source.kind === 'runtime-context').length, 1)
          assert.equal(events.filter(e => e.type === 'assistant/message').length, 2)
        } finally { await reader.close() }
        const extra = config.m5Proof ? await checkM5(ctx, create, inspect, signal) : []
        return Response.json({ checks: ['dedicated-preset', 'scoped-persona', 'scoped-context', 'four-role-tools', 'ordinary-mode-unchanged', 'subagent-excluded', 'durable-binding', 'synthetic-model-only', 'real-tool-execution-unavailable-not-empty', 'runtime-context-deduplicated', 'durable-conversation-log', 'blank-mode-switch-in-and-out', ...extra], status: 'passed' })
      } catch (error) {
        return Response.json({ status: 'failed', error: error instanceof Error ? error.message : 'contract error' }, { status: 500 })
      } finally { for (const handle of handles.reverse()) await handle.dispose(); unregister() }
    },
  }))
}
