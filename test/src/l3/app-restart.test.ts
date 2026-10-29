import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, registerRestartCommand } from '@local/app-restart'
import type { CommandDefinition } from '@local/app-restart'
import { withElectron, withPlatform } from '../harness/env.js'
import { createFakeContext } from '../harness/fake-context.js'

function registry(): { commands: CommandDefinition[]; service: { register: (definition: CommandDefinition) => void } } {
  const commands: CommandDefinition[] = []
  return {
    commands,
    service: {
      register: (definition) => {
        commands.push(definition)
      },
    },
  }
}

function captureWarn<T>(body: () => T): { value: T; messages: string[] } {
  const messages: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((item) => String(item)).join(' '))
  }
  try {
    return { value: body(), messages }
  } finally {
    console.warn = original
  }
}

describe('L3 app-restart: registration and handler', () => {
  it('exposes the loader identity and the commands dependency', () => {
    assert.equal(name, 'app-restart')
    assert.deepEqual(inject, ['commands'])
  })

  it('registers /restart once on a Windows desktop Host', () => {
    withPlatform('win32', () => withElectron(() => {
      const target = registry()
      const ctx = createFakeContext({ commands: target.service })
      apply(ctx as unknown as Context)
      assert.equal(target.commands.length, 1)
      const command = target.commands[0]
      assert.ok(command !== undefined)
      assert.equal(command.name, 'restart')
      assert.match(command.description, /重启 DeepSeek Harness/)
    }))
  })

  it('invokes the restart side effect exactly once per handler call', () => {
    const target = registry()
    let runs = 0
    registerRestartCommand(target.service, () => {
      runs += 1
    })

    const command = target.commands[0]
    assert.ok(command !== undefined)
    assert.equal(runs, 0, 'registration must not restart anything')

    const first = command.handler()
    assert.equal(runs, 1)
    assert.deepEqual(first, { kind: 'success', text: '正在重启 DeepSeek Harness…' })

    command.handler()
    assert.equal(runs, 2)
  })

  it('warns and does nothing when the commands service is absent', () => {
    withPlatform('win32', () => withElectron(() => {
      const ctx = createFakeContext()
      const { messages } = captureWarn(() => apply(ctx as unknown as Context))
      assert.equal(messages.length, 1)
      assert.match(messages[0] ?? '', /commands service is unavailable/)
      assert.equal(ctx.listeners.length, 0)
    }))
  })

  it('rejects a macOS desktop Host before registering a command', () => {
    withPlatform('darwin', () => withElectron(() => {
      const target = registry()
      const ctx = createFakeContext({ commands: target.service })
      assert.throws(() => apply(ctx as unknown as Context), /current surface=desktop platform=mac/)
      assert.equal(target.commands.length, 0)
      assert.equal(ctx.listeners.length, 0)
    }))
  })

  it('fails before registering when the target does not match', () => {
    const target = registry()
    const ctx = createFakeContext({ commands: target.service })
    assert.throws(() => apply(ctx as unknown as Context), /\[app-restart\] target mismatch/)
    assert.equal(target.commands.length, 0, 'the guard must run before any registration')
  })

  it('rejects the web surface as well', () => {
    const target = registry()
    const ctx = createFakeContext({
      commands: target.service,
      profileContext: { startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
    })
    assert.throws(() => apply(ctx as unknown as Context), /current surface=web/)
  })
})
