/** Exact approval decisions only; never changes the sandbox policy. */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { defaultGrantsFile, GrantStore } from './grants.js'
import { isRootAgent, managementNames, registerManagementTools } from './management.js'
import { normalizeRule, ruleMismatch } from './rules.js'
import type { Rule, ToolCallEvent } from './rules.js'
import { assertTarget } from './targets.js'
export { matchesSubset, normalizeRule, ruleMismatch } from './rules.js'
export type { Rule, ToolCallEvent } from './rules.js'
export { defaultGrantsFile, normalizeGrant, projectMatches, readGrantsFile, writeGrantsFile, GrantStore } from './grants.js'
export type { Grant, GrantScope, GrantsFile } from './grants.js'
export { detectEnvironment, evaluateTarget } from './targets.js'
export const name = 'approval-allowlist'
export const inject = ['tools', 'agents']
export type Mode = 'observe' | 'allow'
export interface Config {
  mode?: Mode
  /** Legacy inline subset rules; per-load counters retained for compatibility. */
  rules?: Rule[]
  /** Relative to current profile; must stay inside it. */
  grantsFile?: string
  rootOnly?: boolean
  log?: boolean
  logFile?: string
  /** Explicit opt-in for temporary observe capture; contains sensitive input. Default false. */
  logArguments?: boolean
}
function findToolCall(agent: Agent, callId: string | undefined): ToolCallEvent | undefined {
  if (!callId) return undefined
  const events = agent.session.ownEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'tool/call' && String(event.data.callId) === callId) return event
  }
  return undefined
}
export function apply(ctx: Context, config: Config = {}): void {
  assertTarget(ctx, name)
  const mode = config.mode === 'allow' ? 'allow' : 'observe'
  const rules = (config.rules ?? []).map(normalizeRule).filter((rule): rule is Rule => rule !== undefined)
  const uses = new Map<number, number>()
  // The profile service is host-owned; absent facts disable persistence, never fall back to env/cwd.
  const profile = ctx.get('profileContext')
  const file = defaultGrantsFile(profile?.dir, config.grantsFile)
  const store = file ? new GrantStore(file, profile?.dir) : undefined
  if (store) registerManagementTools(ctx, store)
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const now = Date.now()
    const toolCall = findToolCall(req.agent, req.callId)
    const projectRoot = req.agent.session.header?.cwd
    let decision: 'observe' | 'allow' | 'next' = 'next'
    let detail = 'no-tool-call'
    let matchedRule: string | number | undefined
    if (req.signal?.aborted) detail = 'cancelled'
    else if (managementNames.has(req.toolName)) detail = 'management-never-auto-approved'
    else if (toolCall && toolCall.data.name !== req.toolName) detail = 'tool-name-mismatch'
    else if (toolCall && (config.rootOnly ?? true) && !isRootAgent(ctx, req.agent)) detail = 'not-root'
    else if (toolCall) {
      detail = 'no-match'
      let validFile = true
      try {
        const grant = store?.match(toolCall.data.name, JSON.parse(toolCall.data.arguments), projectRoot, mode === 'allow')
        if (grant) matchedRule = grant.id
      } catch { validFile = false; detail = 'invalid-grants-or-arguments' }
      if (matchedRule === undefined && validFile) {
        for (let index = 0; index < rules.length; index++) {
          const rule = rules[index]!
          if (managementNames.has(rule.tool) || ruleMismatch(rule, toolCall, now)) continue
          const used = uses.get(index) ?? 0
          if (rule.maxUses && used >= rule.maxUses) continue
          matchedRule = index
          if (mode === 'allow' && rule.maxUses) uses.set(index, used + 1)
          break
        }
      }
      if (matchedRule !== undefined) { decision = mode === 'allow' ? 'allow' : 'observe'; detail = mode === 'allow' ? 'allowed' : 'observe-match' }
    }
    if (config.log ?? true) {
      try {
        appendFileSync(config.logFile || join(tmpdir(), 'dsh-approval-allowlist.log'), JSON.stringify({
          time: new Date(now).toISOString(), mode, decision, detail, matchedRule,
          tool: toolCall?.data.name ?? req.toolName, callId: req.callId,
          argumentKeys: (() => { try { return Object.keys(JSON.parse(toolCall?.data.arguments ?? '{}')) } catch { return [] } })(),
          argumentsHash: toolCall ? createHash('sha256').update(toolCall.data.arguments).digest('hex') : undefined,
          ...(config.logArguments ? { arguments: toolCall?.data.arguments, reason: req.reason, projectRoot } : {}),
        }) + '\n', { encoding: 'utf8', mode: 0o600 })
      } catch { console.warn('[approval-allowlist] cannot write audit log') }
    }
    return decision === 'allow' ? 'allowed-once' : next()
  }, { global: true })
}
