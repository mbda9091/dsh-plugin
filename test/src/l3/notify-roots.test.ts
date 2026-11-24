import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { rootAgents } from '@mbda9091/notify-host'
import { createFakeContext } from '../harness/fake-context.js'

it('L3 roots: uses live tree ownership for nested members and contains detached ownership', () => {
  const root = { session: Session.create(SessionId('root')) }
  const fork = { session: Session.create(SessionId('fork'), [], { ...root.session.header, id: SessionId('fork'), parentSession: root.session.id, isSeeded: true }, SessionLogOffset(0)) }
  const child = { session: Session.create(SessionId('child'), [], { ...root.session.header, id: SessionId('child'), origin: 'subagent' }) }
  const nested = { session: Session.create(SessionId('nested')) }
  const detached = { session: Session.create(SessionId('detached')) }
  const ctx = createFakeContext({
    agents: { list: () => [root, fork, child, nested, detached] },
    subagents: { rootOf(agent: Agent) {
      if (agent.session === detached.session) throw new Error('owner unavailable')
      if (agent.session === child.session || agent.session === nested.session) return root
      return agent
    } },
  })
  assert.deepEqual(rootAgents(ctx as unknown as Context), [root, fork])
})

it('L3 roots: without subagents, ordinary forks remain roots and delegated sessions stay silent', () => {
  const root = { session: Session.create(SessionId('root')) }
  const fork = { session: Session.create(SessionId('fork'), [], { ...root.session.header, id: SessionId('fork'), parentSession: root.session.id, isSeeded: true }, SessionLogOffset(0)) }
  const child = { session: Session.create(SessionId('child'), [], { ...root.session.header, id: SessionId('child'), origin: 'subagent' }) }
  const ctx = createFakeContext({ agents: { list: () => [root, fork, child] } })
  assert.deepEqual(rootAgents(ctx as unknown as Context), [root, fork])
  ctx.services.set('subagents', { rootOf() { throw new Error('service unavailable') } })
  assert.deepEqual(rootAgents(ctx as unknown as Context), [])
  ctx.services.delete('agents')
  assert.deepEqual(rootAgents(ctx as unknown as Context), [])
})
