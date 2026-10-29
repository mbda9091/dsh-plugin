/**
 * Approval allowlist for exact tool calls.
 *
 * The plugin never matches on `reason` text: it resolves `req.callId` to the
 * durable `tool/call` event and compares the raw arguments with configured
 * rules. Default mode is `observe`, which only writes a JSONL audit record and
 * lets the normal approval flow continue.
 *
 * @module @local/approval-allowlist
 */
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { normalizeRule, ruleMismatch } from './rules.js'
import type { Rule, ToolCallEvent } from './rules.js'
import { assertTarget } from './targets.js'

// Re-exported for the unit tests: the matching rules are pure, and the target
// decision is exercised with explicit environments. Runtime behaviour is
// unchanged: `apply` still uses them internally.
export { matchesSubset, normalizeRule, ruleMismatch } from './rules.js'
export type { Rule, ToolCallEvent } from './rules.js'
export { detectEnvironment, evaluateTarget } from './targets.js'

/** Loader row identity; independent from the package name. */
export const name = 'approval-allowlist'

/** `observe` only logs; `allow` can return allowed-once for exact matches. */
export type Mode = 'observe' | 'allow'

/** Plugin configuration. */
export interface Config {
  /** Default `observe`. */
  mode?: Mode
  /** Exact rules; empty means observe-only/no grants. */
  rules?: Rule[]
  /** Only allow requests from root agents. Default true. */
  rootOnly?: boolean
  /** Write a JSONL audit record for every approval request. Default true. */
  log?: boolean
  /** Audit log path. Default `%TEMP%/dsh-approval-allowlist.log`. */
  logFile?: string
}

interface Options {
  mode: Mode
  rules: Rule[]
  rootOnly: boolean
  log: boolean
  logFile: string
}

/** Resolve the durable tool call that a request belongs to. */
function findToolCall(agent: Agent, callId: string | undefined): ToolCallEvent | undefined {
  if (callId === undefined) return undefined
  const events = agent.session.ownEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && String(event.data.callId) === callId) return event
  }
  return undefined
}

/** Whether the request agent is a live root agent (best effort). */
function isRootAgent(ctx: Context, agent: Agent): boolean {
  const agents = ctx.get('agents')
  if (agents === undefined) return true
  try {
    return agents.roots().includes(agent)
  } catch {
    return false
  }
}

/** Append one audit record without letting logging failure affect approval. */
function writeLog(options: Options, record: Record<string, unknown>): void {
  if (!options.log) return
  try {
    appendFileSync(options.logFile, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    console.warn('[approval-allowlist] cannot write audit log:', error)
  }
}

/** Register the approval waterfall listener. */
export function apply(ctx: Context, config: Config = {}): void {
  assertTarget(ctx, name)

  const rules = Array.isArray(config.rules)
    ? config.rules.map(normalizeRule).filter((rule): rule is Rule => rule !== undefined)
    : []
  const options: Options = {
    mode: config.mode === 'allow' ? 'allow' : 'observe',
    rules,
    rootOnly: config.rootOnly ?? true,
    log: config.log ?? true,
    logFile: typeof config.logFile === 'string' && config.logFile !== ''
      ? config.logFile
      : join(tmpdir(), 'dsh-approval-allowlist.log'),
  }
  const uses = new Map<number, number>()

  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const now = Date.now()
    const toolCall = findToolCall(req.agent, req.callId)
    let decision: 'observe' | 'allow' | 'next' = 'next'
    let detail = 'no-tool-call'
    let matchedRule: number | undefined

    if (toolCall === undefined) {
      detail = 'no-tool-call'
    } else if (options.rootOnly && !isRootAgent(ctx, req.agent)) {
      detail = 'not-root'
    } else {
      for (let index = 0; index < options.rules.length; index += 1) {
        const rule = options.rules[index]
        if (rule === undefined) continue
        const mismatch = ruleMismatch(rule, toolCall, now)
        if (mismatch !== undefined) {
          detail = mismatch
          continue
        }
        const maxUses = rule.maxUses ?? Number.POSITIVE_INFINITY
        const used = uses.get(index) ?? 0
        if (Number.isFinite(maxUses) && used >= maxUses) {
          detail = 'max-uses'
          continue
        }
        matchedRule = index
        if (options.mode === 'allow') {
          if (Number.isFinite(maxUses)) uses.set(index, used + 1)
          decision = 'allow'
          detail = 'allowed'
        } else {
          decision = 'observe'
          detail = 'observe-match'
        }
        break
      }
      if (matchedRule === undefined) detail = 'no-match'
    }

    writeLog(options, {
      time: new Date(now).toISOString(),
      mode: options.mode,
      decision,
      detail,
      matchedRule,
      tool: toolCall?.data.name ?? req.toolName,
      callId: req.callId,
      reason: req.reason,
      arguments: toolCall?.data.arguments,
    })

    if (decision === 'allow') return 'allowed-once'
    return next()
  }, { global: true })
}
