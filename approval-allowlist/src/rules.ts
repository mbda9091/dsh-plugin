/**
 * Pure rule matching for the approval allowlist.
 *
 * Kept separate from the Host wiring so the matching semantics can be tested
 * without a live approval waterfall: exact tool name, subset of parsed
 * arguments, optional usage limit, optional expiry.
 *
 * @module @local/approval-allowlist/rules
 */
import { isDeepStrictEqual } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One exact tool-call rule. */
export interface Rule {
  /** Exact tool name from the tool/call event. */
  tool: string
  /**
   * Subset of the parsed tool arguments. Every key must equal the actual value;
   * arrays and primitives use deep equality. Empty objects are ignored.
   */
  arguments?: Record<string, unknown>
  /** Maximum grants per plugin load. Omit or use 0 for unlimited; otherwise a positive safe integer. */
  maxUses?: number
  /** Optional ISO-8601 expiry; invalid values never match. */
  expiresAt?: string
  /** Free-form note included in the audit log. */
  note?: string
}

/** The durable `tool/call` event a request resolves to. */
export type ToolCallEvent = SessionEvent<'tool/call'>

/** True for a plain JSON object (not an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Match a configured subset against parsed tool arguments.
 *
 * Objects are matched recursively by key; primitives and arrays must be deeply
 * equal. Extra actual keys are allowed, so a rule can pin only the fields that
 * matter (tool name, command, workdir, ...).
 */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false
    return Object.entries(expected).every(([key, value]) => key in actual && matchesSubset(value, actual[key]))
  }
  return isDeepStrictEqual(expected, actual)
}

/**
 * Validate and normalize one rule from the loader row.
 *
 * Invalid `maxUses` values are rejected with a log that names the rule index;
 * the caller skips that rule and keeps matching the remaining ones. `0` and an
 * omitted value both mean unlimited.
 */
export function normalizeRule(value: unknown, index: number): Rule | undefined {
  if (!isRecord(value) || typeof value.tool !== 'string') return undefined
  if (!isRecord(value.arguments) || Object.keys(value.arguments).length === 0) return undefined
  const rule: Rule = { tool: value.tool, arguments: value.arguments }
  if (value.maxUses !== undefined) {
    if (typeof value.maxUses !== 'number' || !Number.isSafeInteger(value.maxUses) || value.maxUses < 0) {
      console.error(`[approval-allowlist] rules[${index}].maxUses must be 0 (unlimited) or a positive safe integer; skipping rule`)
      return undefined
    }
    if (value.maxUses > 0) rule.maxUses = value.maxUses
  }
  if (typeof value.expiresAt === 'string') rule.expiresAt = value.expiresAt
  if (typeof value.note === 'string') rule.note = value.note
  return rule
}

/** Why a rule did not match, for the audit log. */
export function ruleMismatch(rule: Rule, toolCall: ToolCallEvent, now: number): string | undefined {
  if (toolCall.data.name !== rule.tool) return 'tool'
  if (rule.expiresAt !== undefined) {
    const expiry = Date.parse(rule.expiresAt)
    if (Number.isNaN(expiry) || now > expiry) return 'expired'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(toolCall.data.arguments)
  } catch {
    return 'arguments-json'
  }
  if (!matchesSubset(rule.arguments, parsed)) return 'arguments'
  return undefined
}
