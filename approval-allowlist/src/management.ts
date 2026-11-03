import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { GrantStore, normalizeGrant } from './grants.js'
import { isRecord } from './rules.js'

export const managementNames = new Set(['approval_allow', 'approval_revoke', 'approval_list'])
export function isRootAgent(ctx: Context, agent: Agent): boolean {
  try { return ctx.get('agents')?.roots().includes(agent) === true && agent.session.header?.origin !== 'subagent' }
  catch { return false }
}
/** Each mutation asks the ordinary approval service; our allowlist never answers these requests. */
export function registerManagementTools(ctx: Context, store: GrantStore): void {
  const tools = ctx.get('tools')
  if (!tools) return
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  for (const name of managementNames) {
    const definition: ToolDefinition = {
      name,
      description: name === 'approval_allow'
        ? 'Add a project/permanent exact write/edit/bash approval rule. Requires a live root agent and a separate human approval; cannot auto-approve itself. Pass rule as JSON string, omitting id/used.'
        : name === 'approval_revoke' ? 'Revoke a grant by id after separate human approval.' : 'List profile approval grants (root agents only).',
      parameters: { type: 'object', properties: name === 'approval_allow' ? { rule: { type: 'string' } } : name === 'approval_revoke' ? { id: { type: 'string' } } : {}, required: name === 'approval_allow' ? ['rule'] : name === 'approval_revoke' ? ['id'] : [], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent || !isRootAgent(ctx, agent)) throw new Error('approval management requires a live root agent')
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        if (!isRecord(args)) throw new Error('invalid arguments')
        if (name === 'approval_list') return JSON.stringify(store.read())
        const grant = name === 'approval_allow' && typeof args.rule === 'string' ? normalizeGrant({ ...JSON.parse(args.rule), id: randomUUID(), used: 0 }) : undefined
        if (name === 'approval_allow' && !grant) throw new Error('invalid grant')
        if (grant?.scope === 'project' && grant.projectRoot !== agent.session.header.cwd) throw new Error('projectRoot must equal the calling session original cwd')
        if (name === 'approval_revoke' && (typeof args.id !== 'string' || !store.read().some(rule => rule.id === args.id))) throw new Error('unknown grant id')
        const approval = ctx.get('approval')
        if (!approval) throw new Error('approval service unavailable')
        const outcome = await approval.request({ agent, toolName: name, callId: exec.callId, signal, reason: `Change profile approval grants: ${grant ? JSON.stringify(grant) : `revoke ${String(args.id)}`}` })
        signal.throwIfAborted()
        if (outcome !== 'allowed-once' || !isRootAgent(ctx, agent)) throw new Error('grant mutation was not approved')
        return store.transaction(rules => {
          if (grant) rules.push(grant)
          else {
            const index = rules.findIndex(rule => rule.id === args.id)
            if (index < 0) throw new Error('grant disappeared before revocation')
            rules.splice(index, 1)
          }
          return { value: JSON.stringify({ ok: true, id: grant?.id ?? args.id }), save: true }
        })
      },
    }
    tools.register(definition)
  }
}
