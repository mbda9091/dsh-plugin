import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchesSubset, normalizeRule, ruleMismatch } from '@local/approval-allowlist'
import type { Rule, ToolCallEvent } from '@local/approval-allowlist'

/** Build the slice of `tool/call` that the matcher reads. */
function toolCall(name: string, args: unknown): ToolCallEvent {
  const raw = typeof args === 'string' ? args : JSON.stringify(args)
  return { type: 'tool/call', data: { name, arguments: raw } } as unknown as ToolCallEvent
}

function captureErrors<T>(body: () => T): { value: T; messages: string[] } {
  const messages: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    messages.push(args.map((item) => String(item)).join(' '))
  }
  try {
    return { value: body(), messages }
  } finally {
    console.error = original
  }
}

describe('L1 approval-allowlist: subset matching', () => {
  it('allows extra actual keys', () => {
    assert.equal(matchesSubset({ command: 'x' }, { command: 'x', workdir: 'y' }), true)
    assert.equal(matchesSubset({ command: 'x' }, { command: 'x', workdir: 'y' }), true)
  })

  it('matches nested objects by subset', () => {
    assert.equal(matchesSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } }), true)
    assert.equal(matchesSubset({ a: { b: 2 } }, { a: { b: 1, c: 2 } }), false)
    assert.equal(matchesSubset({ a: { b: 1 } }, { a: 1 }), false)
  })

  it('compares arrays by full deep equality', () => {
    assert.equal(matchesSubset({ list: ['a', 'b'] }, { list: ['a', 'b'] }), true)
    assert.equal(matchesSubset({ list: ['a'] }, { list: ['a', 'b'] }), false)
    assert.equal(matchesSubset({ list: ['a', 'b'] }, { list: 'a,b' }), false)
  })

  it('compares primitives strictly', () => {
    assert.equal(matchesSubset(1, 1), true)
    assert.equal(matchesSubset(1, '1'), false)
    assert.equal(matchesSubset(null, null), true)
    assert.equal(matchesSubset(null, undefined), false)
    assert.equal(matchesSubset(true, false), false)
  })
})

describe('L1 approval-allowlist: rule normalization', () => {
  it('keeps valid limits, expiry and note', () => {
    const rule = normalizeRule(
      { tool: 'pwsh', arguments: { command: 'x' }, maxUses: 3, expiresAt: '2999-01-01T00:00:00Z', note: 'note' },
      0,
    )
    assert.deepEqual(rule, {
      tool: 'pwsh',
      arguments: { command: 'x' },
      maxUses: 3,
      expiresAt: '2999-01-01T00:00:00Z',
      note: 'note',
    })
  })

  it('treats omitted and zero limits as unlimited', () => {
    const omitted = normalizeRule({ tool: 'pwsh', arguments: { command: 'x' } }, 0)
    assert.equal(omitted?.maxUses, undefined)
    const zero = normalizeRule({ tool: 'pwsh', arguments: { command: 'x' }, maxUses: 0 }, 0)
    assert.equal(zero?.maxUses, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(zero, 'maxUses'), false)
  })

  it('rejects invalid usage limits and names the rule index', () => {
    const invalid = [-1, 1.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]
    for (const maxUses of invalid) {
      const { value, messages } = captureErrors(() =>
        normalizeRule({ tool: 'pwsh', arguments: { command: 'x' }, maxUses }, 2),
      )
      assert.equal(value, undefined, `maxUses=${String(maxUses)} must be rejected`)
      assert.equal(messages.length, 1)
      assert.match(messages[0] ?? '', /rules\[2\]\.maxUses/)
    }
  })

  it('rejects malformed rules without logging', () => {
    const cases: unknown[] = [
      null,
      'pwsh',
      { arguments: { command: 'x' } },
      { tool: 42, arguments: { command: 'x' } },
      { tool: 'pwsh' },
      { tool: 'pwsh', arguments: {} },
      { tool: 'pwsh', arguments: [] },
    ]
    for (const value of cases) {
      const { value: rule, messages } = captureErrors(() => normalizeRule(value, 0))
      assert.equal(rule, undefined, `expected ${JSON.stringify(value)} to be rejected`)
      assert.deepEqual(messages, [])
    }
  })

  it('ignores non-string expiry and note instead of failing the rule', () => {
    const rule = normalizeRule({ tool: 'pwsh', arguments: { command: 'x' }, expiresAt: 5, note: {} }, 0)
    assert.ok(rule !== undefined)
    assert.equal(rule.expiresAt, undefined)
    assert.equal(rule.note, undefined)
  })
})

describe('L1 approval-allowlist: mismatch reasons', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const rule: Rule = { tool: 'pwsh', arguments: { command: 'node test.mjs' } }

  it('matches the exact tool and arguments', () => {
    assert.equal(ruleMismatch(rule, toolCall('pwsh', { command: 'node test.mjs' }), now), undefined)
    assert.equal(
      ruleMismatch(rule, toolCall('pwsh', { command: 'node test.mjs', timeoutMs: 1000 }), now),
      undefined,
    )
  })

  it('reports a tool mismatch first', () => {
    assert.equal(ruleMismatch(rule, toolCall('read', { command: 'node test.mjs' }), now), 'tool')
  })

  it('reports expired and invalid expiry', () => {
    assert.equal(ruleMismatch({ ...rule, expiresAt: '2000-01-01T00:00:00Z' }, toolCall('pwsh', rule.arguments), now), 'expired')
    assert.equal(ruleMismatch({ ...rule, expiresAt: 'not-a-date' }, toolCall('pwsh', rule.arguments), now), 'expired')
    assert.equal(ruleMismatch({ ...rule, expiresAt: '2999-01-01T00:00:00Z' }, toolCall('pwsh', rule.arguments), now), undefined)
  })

  it('reports unparseable tool arguments', () => {
    assert.equal(ruleMismatch(rule, toolCall('pwsh', 'not json'), now), 'arguments-json')
  })

  it('reports an argument mismatch', () => {
    assert.equal(ruleMismatch(rule, toolCall('pwsh', { command: 'other' }), now), 'arguments')
    assert.equal(ruleMismatch(rule, toolCall('pwsh', {}), now), 'arguments')
  })
})
