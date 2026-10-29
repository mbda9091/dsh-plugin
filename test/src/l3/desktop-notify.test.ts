import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULTS, apply, registerSessionNotifications } from '@local/desktop-notify'
import type { Notify, Options } from '@local/desktop-notify'
import { createFakeContext } from '../harness/fake-context.js'

const desktopSupported = process.platform === 'win32' || process.platform === 'darwin'

interface NotifyCall {
  readonly title: string
  readonly body: string
}

function notifier(): { calls: NotifyCall[]; notify: Notify } {
  const calls: NotifyCall[] = []
  return {
    calls,
    notify: (_options, title, body) => {
      calls.push({ title, body })
    },
  }
}

function options(overrides: Partial<Options> = {}): Options {
  return { ...DEFAULTS, approvalDelayMs: 0, ...overrides }
}

function agentsWith(roots: readonly string[], subs: readonly string[]): {
  list: () => { session: { id: string } }[]
  roots: () => { session: { id: string } }[]
} {
  const rootAgents = roots.map((id) => ({ session: { id } }))
  const subAgents = subs.map((id) => ({ session: { id } }))
  return {
    list: () => [...rootAgents, ...subAgents],
    roots: () => rootAgents,
  }
}

const ROOT = { id: 'root' }
const SUB = { id: 'sub' }
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function approvalAsked(id: string, toolName: string, reason: string): unknown {
  return { type: 'approval/asked', data: { id, toolName, reason } }
}

function approvalDecided(id: string): unknown {
  return { type: 'approval/decided', data: { id } }
}

function turnEnd(reason: unknown): unknown {
  return { type: 'turn/end', data: { reason } }
}

function setup(config: Partial<Options> = {}, services: Record<string, unknown> = { agents: agentsWith(['root'], ['sub']) }): {
  ctx: ReturnType<typeof createFakeContext>
  calls: NotifyCall[]
} {
  const ctx = createFakeContext(services)
  const { calls, notify } = notifier()
  registerSessionNotifications(ctx as unknown as Context, options(config), notify)
  return { ctx, calls }
}

describe('L3 desktop-notify: subscription routing', { skip: !desktopSupported && 'desktop targets only' }, () => {
  it('registers global session/event and agent/disposed listeners', () => {
    const { ctx } = setup()
    assert.equal(ctx.listeners.length, 2)
    const sessionListener = ctx.listeners.find((listener) => listener.event === 'session/event')
    assert.ok(sessionListener !== undefined)
    assert.deepEqual(sessionListener.options, { global: true })
    const disposedListener = ctx.listeners.find((listener) => listener.event === 'agent/disposed')
    assert.ok(disposedListener !== undefined)
    assert.deepEqual(disposedListener.options, { global: true })
  })

  it('rejects a web Host before registering anything', () => {
    const ctx = createFakeContext({
      profileContext: { startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
    })
    assert.throws(() => apply(ctx as unknown as Context, {}), /\[desktop-notify\] target mismatch: .*current surface=web/)
    assert.equal(ctx.listeners.length, 0)
  })

  it('rejects a headless Host before registering anything', () => {
    const ctx = createFakeContext()
    assert.throws(() => apply(ctx as unknown as Context, {}), /\[desktop-notify\] target mismatch: .*current surface=headless/)
    assert.equal(ctx.listeners.length, 0)
  })

  it('notifies for a root-session approval after the delay', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, approvalAsked('a1', 'pwsh', '  need\n access  '))
    assert.equal(calls.length, 0, 'the notification must be delayed')
    await delay(20)
    assert.deepEqual(calls, [{ title: '需要确认权限', body: 'pwsh 正在请求授权：need access' }])
  })

  it('uses fallback text for an unnamed tool and an empty reason', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, approvalAsked('a2', '', ''))
    await delay(20)
    assert.deepEqual(calls, [{ title: '需要确认权限', body: '工具 正在请求授权' }])
  })

  it('cancels the notification when the approval is decided first', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, approvalAsked('a3', 'pwsh', 'x'))
    ctx.emit('session/event', ROOT, approvalDecided('a3'))
    await delay(30)
    assert.deepEqual(calls, [])
  })

  it('does not emit a second notification for a repeated approval id', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, approvalAsked('a4', 'pwsh', 'first'))
    ctx.emit('session/event', ROOT, approvalAsked('a4', 'pwsh', 'second'))
    await delay(30)
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.body ?? '', /first/)
  })

  it('respects notifyOnApproval=false', async () => {
    const { ctx, calls } = setup({ notifyOnApproval: false })
    ctx.emit('session/event', ROOT, approvalAsked('a5', 'pwsh', 'x'))
    await delay(20)
    assert.deepEqual(calls, [])
  })

  it('ignores approvals from subagent sessions', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', SUB, approvalAsked('a6', 'pwsh', 'x'))
    await delay(20)
    assert.deepEqual(calls, [])
  })

  it('stays silent when root identity cannot be confirmed', async () => {
    const { ctx, calls } = setup({}, {})
    ctx.emit('session/event', SUB, approvalAsked('a7', 'pwsh', 'x'))
    await delay(20)
    assert.deepEqual(calls, [])
  })

  it('ignores sessions when the agent registry throws', async () => {
    const { ctx, calls } = setup({}, {
      agents: {
        list: () => {
          throw new Error('registry unavailable')
        },
        roots: () => [],
      },
    })
    ctx.emit('session/event', ROOT, approvalAsked('a8', 'pwsh', 'x'))
    await delay(20)
    assert.deepEqual(calls, [])
  })
})

describe('L3 desktop-notify: turn endings', { skip: !desktopSupported && 'desktop targets only' }, () => {
  it('notifies when a turn completes', () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, turnEnd({ kind: 'completed' }))
    assert.deepEqual(calls, [{ title: '对话已完成', body: '本轮回复已结束，可以回来查看了。' }])
  })

  it('notifies when a turn stops at max-tokens', () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, turnEnd({ kind: 'max-tokens' }))
    assert.equal(calls.length, 1)
  })

  it('notifies with the error message', () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, turnEnd({ kind: 'error', error: { message: '  boom\n happened  ' } }))
    assert.deepEqual(calls, [{ title: '对话出错', body: 'boom happened' }])
  })

  it('stays quiet for aborted, blocked, interrupted and forked turns', () => {
    const { ctx, calls } = setup()
    for (const kind of ['aborted', 'blocked', 'interrupted', 'forked']) {
      ctx.emit('session/event', ROOT, turnEnd({ kind }))
    }
    assert.deepEqual(calls, [])
  })

  it('respects notifyOnTurnEnd and notifyOnTurnError', () => {
    const quietEnd = setup({ notifyOnTurnEnd: false })
    quietEnd.ctx.emit('session/event', ROOT, turnEnd({ kind: 'completed' }))
    assert.deepEqual(quietEnd.calls, [])

    const quietError = setup({ notifyOnTurnError: false })
    quietError.ctx.emit('session/event', ROOT, turnEnd({ kind: 'error', error: { message: 'x' } }))
    assert.deepEqual(quietError.calls, [])
  })

  it('bounds the notification body', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', ROOT, approvalAsked('long', 'pwsh', 'r'.repeat(500)))
    await delay(20)
    const body = calls[0]?.body ?? ''
    assert.ok(body.endsWith('…'))
    assert.ok(body.length <= 'pwsh 正在请求授权：'.length + 180)
  })
})
