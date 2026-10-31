import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, name } from '@local/approval-allowlist'
import type { Config } from '@local/approval-allowlist'
import { createFakeContext } from '../harness/fake-context.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'
import { checkApprovalCapability } from '../../../scripts/.build/core/host-capability.js'

const supported = process.platform === 'win32' || process.platform === 'darwin'

interface CallSpec {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

interface FakeAgent {
  readonly session: {
    readonly id: string
    ownEvents: () => unknown[]
  }
}

function agentWith(calls: readonly CallSpec[], id = 'agent-session'): FakeAgent {
  return {
    session: {
      id,
      ownEvents: () =>
        calls.map((call) => ({
          type: 'tool/call',
          data: {
            callId: call.callId,
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
          },
        })),
    },
  }
}

let tempRoot = ''

before(() => {
  tempRoot = makeTempDir('allowlist')
})

after(() => {
  removeDir(tempRoot)
})

async function captureConsole<T>(method: 'warn' | 'error', body: () => Promise<T> | T): Promise<{ value: T; messages: string[] }> {
  const messages: string[] = []
  const original = console[method]
  console[method] = (...args: unknown[]) => {
    messages.push(args.map((item) => String(item)).join(' '))
  }
  try {
    return { value: await body(), messages }
  } finally {
    console[method] = original
  }
}

interface Harness {
  ctx: ReturnType<typeof createFakeContext>
  root: FakeAgent
  sub: FakeAgent
  logFile: string
  invoke: (agent: FakeAgent, callId: string | undefined) => Promise<unknown>
  log: () => Record<string, unknown>[]
}

function setup(
  config: Config,
  options: { calls?: readonly CallSpec[]; logName?: string; logFile?: string } = {},
): Harness {
  const root = agentWith(options.calls ?? [{ callId: 'c1', name: 'pwsh', arguments: { command: 'x' } }], 'root')
  const sub = agentWith([{ callId: 'sub-call', name: 'pwsh', arguments: { command: 'sub' } }], 'sub')
  const agents = {
    list: () => [root, sub],
    roots: () => [root],
  }
  const ctx = createFakeContext({
    profileContext: { startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
    agents,
  })
  const logFile = options.logFile ?? join(tempRoot, `${options.logName ?? 'audit'}.jsonl`)
  apply(ctx as unknown as Context, { ...config, logFile })

  const listener = ctx.listeners.find((entry) => entry.event === 'approval/request')
  assert.ok(listener !== undefined, 'apply must register an approval/request waterfall listener')

  return {
    ctx,
    root,
    sub,
    logFile,
    invoke: async (agent, callId) => {
      const next = async (): Promise<string> => 'next'
      return listener.handler({ agent, callId, toolName: 'pwsh', reason: 'test reason' }, next)
    },
    log: () => readLog(logFile),
  }
}

function readLog(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('L3 approval-allowlist: registration', { skip: !supported && 'windows/mac targets only' }, () => {
  it('satisfies the same behavioral contract used for fixed tarball acceptance', async () => {
    await checkApprovalCapability({ apply }, tempRoot)
    await assert.rejects(checkApprovalCapability({ apply() {} }, tempRoot), /register approval/)
  })
  it('exposes the loader identity and registers a global waterfall listener', () => {
    assert.equal(name, 'approval-allowlist')
    const harness = setup({ mode: 'observe', rules: [] })
    assert.equal(harness.ctx.listeners.length, 1)
    assert.deepEqual(harness.ctx.listeners[0]?.options, { global: true })
  })

  it('rejects a headless Host before registering', () => {
    const ctx = createFakeContext()
    assert.throws(() => apply(ctx as unknown as Context, {}), /\[approval-allowlist\] target mismatch: .*current surface=headless/)
    assert.equal(ctx.listeners.length, 0)
  })
})

describe('L3 approval-allowlist: observe and allow', { skip: !supported && 'windows/mac targets only' }, () => {
  it('observes an exact match and lets the normal flow continue', async () => {
    const args = { command: 'node test/e2e/web-l5.mjs', workdir: 'C:\\example\\workspace' }
    const harness = setup(
      { mode: 'observe', rules: [{ tool: 'pwsh', arguments: { command: args.command }, note: 'l5' }] },
      { calls: [{ callId: 'c1', name: 'pwsh', arguments: args }], logName: 'observe' },
    )

    assert.equal(await harness.invoke(harness.root, 'c1'), 'next')
    const records = harness.log()
    assert.equal(records.length, 1)
    const record = records[0]
    assert.ok(record !== undefined)
    assert.equal(record['mode'], 'observe')
    assert.equal(record['decision'], 'observe')
    assert.equal(record['detail'], 'observe-match')
    assert.equal(record['matchedRule'], 0)
    assert.equal(record['tool'], 'pwsh')
    assert.equal(record['callId'], 'c1')
    assert.equal(record['reason'], 'test reason')
    assert.equal(record['arguments'], JSON.stringify(args))
    assert.ok(Number.isFinite(Date.parse(String(record['time']))))
  })

  it('allows an exact match and lets additional actual keys through', async () => {
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] },
      {
        calls: [{ callId: 'c1', name: 'pwsh', arguments: { command: 'x', workdir: 'y', timeoutMs: 1000 } }],
        logName: 'allow',
      },
    )

    assert.equal(await harness.invoke(harness.root, 'c1'), 'allowed-once')
    assert.equal(harness.log()[0]?.['decision'], 'allow')
    assert.equal(harness.log()[0]?.['detail'], 'allowed')
  })

  it('never allows a different tool or different arguments', async () => {
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] },
      {
        calls: [
          { callId: 'c1', name: 'read', arguments: { command: 'x' } },
          { callId: 'c2', name: 'pwsh', arguments: { command: 'z' } },
        ],
        logName: 'mismatch',
      },
    )
    assert.equal(await harness.invoke(harness.root, 'c1'), 'next')
    assert.equal(await harness.invoke(harness.root, 'c2'), 'next')
  })

  it('enforces maxUses and then falls back to the normal approval', async () => {
    const calls: CallSpec[] = ['c1', 'c2', 'c3'].map((callId) => ({ callId, name: 'pwsh', arguments: { command: 'x' } }))
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' }, maxUses: 2 }] },
      { calls, logName: 'maxuses' },
    )

    assert.equal(await harness.invoke(harness.root, 'c1'), 'allowed-once')
    assert.equal(await harness.invoke(harness.root, 'c2'), 'allowed-once')
    assert.equal(await harness.invoke(harness.root, 'c3'), 'next')

    const decisions = harness.log().map((record) => record['decision'])
    assert.deepEqual(decisions, ['allow', 'allow', 'next'])
  })

  it('treats maxUses=0 as unlimited', async () => {
    const calls: CallSpec[] = ['c1', 'c2', 'c3'].map((callId) => ({ callId, name: 'pwsh', arguments: { command: 'x' } }))
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' }, maxUses: 0 }] },
      { calls, logName: 'unlimited' },
    )
    for (const callId of ['c1', 'c2', 'c3']) {
      assert.equal(await harness.invoke(harness.root, callId), 'allowed-once')
    }
    assert.equal(harness.log().filter((record) => record['decision'] === 'allow').length, 3)
  })

  it('skips expired and invalid-expiry rules', async () => {
    const past = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' }, expiresAt: '2000-01-01T00:00:00Z' }] },
      { logName: 'expired' },
    )
    assert.equal(await past.invoke(past.root, 'c1'), 'next')

    const invalid = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' }, expiresAt: 'not-a-date' }] },
      { logName: 'expired-invalid' },
    )
    assert.equal(await invalid.invoke(invalid.root, 'c1'), 'next')
  })

  it('skips rules whose call cannot be resolved', async () => {
    const harness = setup({ mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] }, { logName: 'nocall' })
    assert.equal(await harness.invoke(harness.root, undefined), 'next')
    assert.equal(harness.log()[0]?.['detail'], 'no-tool-call')
    assert.equal(harness.log()[0]?.['tool'], 'pwsh')

    assert.equal(await harness.invoke(harness.root, 'unknown-call'), 'next')
    assert.equal(harness.log()[1]?.['detail'], 'no-tool-call')
  })

  it('skips unparseable tool arguments', async () => {
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] },
      { calls: [{ callId: 'c1', name: 'pwsh', arguments: 'not json' }], logName: 'badargs' },
    )
    assert.equal(await harness.invoke(harness.root, 'c1'), 'next')
  })
})

describe('L3 approval-allowlist: agent scope and rule validation', { skip: !supported && 'windows/mac targets only' }, () => {
  it('only allows root agents by default', async () => {
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'sub' } }] },
      { logName: 'subagent' },
    )
    assert.equal(await harness.invoke(harness.sub, 'sub-call'), 'next')
    assert.equal(harness.log()[0]?.['detail'], 'not-root')

    const permissive = setup(
      { mode: 'allow', rootOnly: false, rules: [{ tool: 'pwsh', arguments: { command: 'sub' } }] },
      { logName: 'subagent-allowed' },
    )
    assert.equal(await permissive.invoke(permissive.sub, 'sub-call'), 'allowed-once')
  })

  it('logs and skips invalid maxUses, then keeps matching valid rules', async () => {
    const { value: harness, messages } = await captureConsole('error', () =>
      setup(
        {
          mode: 'allow',
          rules: [
            { tool: 'pwsh', arguments: { command: 'x' }, maxUses: -1 },
            { tool: 'pwsh', arguments: { command: 'x' }, maxUses: 1 },
          ],
        },
        { logName: 'invalid-rule' },
      ),
    )
    assert.equal(messages.length, 1)
    assert.match(messages[0] ?? '', /rules\[0\]\.maxUses/)
    assert.equal(await harness.invoke(harness.root, 'c1'), 'allowed-once')
    assert.equal(harness.log()[0]?.['matchedRule'], 0, 'the surviving rule is re-indexed')
  })
})

describe('L3 approval-allowlist: audit logging', { skip: !supported && 'windows/mac targets only' }, () => {
  it('does not write when log=false', async () => {
    const harness = setup(
      { mode: 'allow', log: false, rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] },
      { logName: 'nolog' },
    )
    assert.equal(await harness.invoke(harness.root, 'c1'), 'allowed-once')
    assert.equal(existsSync(harness.logFile), false)
  })

  it('warns instead of failing when the audit file cannot be written', async () => {
    const harness = setup(
      { mode: 'allow', rules: [{ tool: 'pwsh', arguments: { command: 'x' } }] },
      { logFile: join(tempRoot, 'missing-directory', 'audit.jsonl') },
    )
    const { value: result, messages } = await captureConsole('warn', () => harness.invoke(harness.root, 'c1'))
    assert.equal(result, 'allowed-once')
    assert.equal(messages.length, 1)
    assert.match(messages[0] ?? '', /cannot write audit log/)
  })
})
