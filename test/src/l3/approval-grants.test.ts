import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, GrantStore, defaultGrantsFile, normalizeGrant, writeGrantsFile } from '@local/approval-allowlist'
import type { Grant } from '@local/approval-allowlist'
import { createFakeContext } from '../harness/fake-context.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'
import { discoverPlugins } from '../../../scripts/.build/core/plugins.js'
import { isTargetCompatible, resolveTarget } from '../../../scripts/.build/core/targets.js'

const plugin = discoverPlugins(repoRoot).find(plugin => plugin.dirName === 'approval-allowlist')
assert.ok(plugin, 'approval-allowlist manifest is required')
const supportsApply = (process.platform === 'win32' || process.platform === 'darwin')
  && isTargetCompatible(plugin, resolveTarget({ surface: 'web' }))

function grant(root: string, overrides: Partial<Grant> = {}): Grant {
  const path = join(root, 'out.json')
  return { id: 'one', scope: 'project', projectRoot: root, tool: 'write', path, arguments: { file_path: path, sandbox_permissions: 'workspace-write' }, ...overrides }
}
it('durable grants require explicit scope/id, exact path or command, cwd and sandbox mode', () => {
  const root = makeTempDir('grant-schema')
  try {
    const good = grant(root)
    assert.ok(normalizeGrant(good))
    for (const value of [{ ...good, scope: 'session' }, { ...good, id: undefined }, { ...good, path: '/different' }, { ...good, arguments: {} }, { ...good, projectRoot: 'relative' }, { ...good, maxUses: -1 }, { ...good, expiresAt: 'bad' }, { ...good, extra: true }]) assert.equal(normalizeGrant(value), undefined)
    assert.equal(normalizeGrant({ ...good, tool: 'bash' }), undefined)
    assert.ok(normalizeGrant({ id: 'bash', scope: 'permanent', tool: 'bash', arguments: { command: 'echo ok', workdir: root, sandbox_permissions: 'workspace-write' } }))
    assert.equal(defaultGrantsFile(undefined), undefined)
    assert.throws(() => defaultGrantsFile(root, '../escape.json'))
  } finally { removeDir(root) }
})
it('store rereads external changes, persists limits across reload, rejects corrupt files and locks', () => {
  const root = makeTempDir('grant-store')
  try {
    const file = join(root, 'grants.json'), rule = grant(root, { maxUses: 1 })
    writeGrantsFile(file, [rule])
    const store = new GrantStore(file)
    assert.equal(store.match('write', rule.arguments, join(root, 'other'), true), undefined)
    assert.equal(store.match('write', { ...rule.arguments, sandbox_permissions: 'danger-full-access' }, root, true), undefined)
    assert.equal(store.match('write', rule.arguments, root, false)?.id, 'one')
    assert.equal(store.match('write', rule.arguments, root, true)?.used, 1)
    assert.equal(new GrantStore(file).match('write', rule.arguments, root, true), undefined)
    writeFileSync(file, '{')
    assert.throws(() => store.match('write', rule.arguments, root, true))
    writeGrantsFile(file, [grant(root, { scope: 'permanent', projectRoot: undefined })])
    assert.ok(store.match('write', rule.arguments, join(root, 'other'), true))
    writeFileSync(`${file}.lock`, '')
    assert.throws(() => store.match('write', rule.arguments, root, true))
    unlinkSync(`${file}.lock`)
    unlinkSync(file)
    assert.equal(store.match('write', rule.arguments, root, true), undefined)
  } finally { removeDir(root) }
})
it('exact bash grants reject command, workdir, sandbox changes and expired rules', () => {
  const root = makeTempDir('grant-bash')
  try {
    const file = join(root, 'grants.json')
    const rule: Grant = { id: 'bash', scope: 'permanent', tool: 'bash', arguments: { command: 'echo ok', workdir: root, sandbox_permissions: 'workspace-write' } }
    writeGrantsFile(file, [rule])
    const store = new GrantStore(file)
    assert.ok(store.match('bash', rule.arguments, undefined, false))
    for (const args of [{ ...rule.arguments, command: 'echo other' }, { ...rule.arguments, workdir: join(root, 'other') }, { ...rule.arguments, sandbox_permissions: 'danger-full-access' }]) assert.equal(store.match('bash', args, undefined, true), undefined)
    writeGrantsFile(file, [{ ...rule, expiresAt: new Date(Date.now() - 1).toISOString() }])
    assert.equal(store.match('bash', rule.arguments, undefined, true), undefined)
  } finally { removeDir(root) }
})
it('profile isolation rejects symlink escapes and structured self-authorization', { skip: process.platform === 'win32' }, () => {
  const root = makeTempDir('grant-profile')
  try {
    const profile = join(root, 'profile'), outside = join(root, 'outside')
    mkdirSync(profile); mkdirSync(outside)
    symlinkSync(outside, join(profile, 'linked'))
    const escaped = new GrantStore(join(profile, 'linked/grants.json'), profile)
    assert.throws(() => escaped.read(), /escapes profile/)
    const file = join(profile, 'grants.json')
    const rule = grant(root, { path: file, arguments: { file_path: file, sandbox_permissions: 'danger-full-access' } })
    writeGrantsFile(file, [rule])
    assert.equal(new GrantStore(file, profile).match('write', rule.arguments, root, true), undefined)
    assert.equal(normalizeGrant({ ...rule, path: join(root, 'result'), arguments: { ...rule.arguments, file_path: `${root}/linked/../result` } }), undefined)
  } finally { removeDir(root) }
})
it('Windows grants reject root-relative and drive-relative paths', { skip: process.platform !== 'win32' }, () => {
  for (const path of ['\\\\shared\\\\out.json', 'C:out.json', '/out.json']) assert.equal(normalizeGrant({ id: 'bad', scope: 'permanent', tool: 'write', path, arguments: { file_path: path, sandbox_permissions: 'workspace-write' } }), undefined)
})
it('host profile grants reload, redact audit, prevent self-approval, require independent mutation approval', { skip: !supportsApply && 'approval-allowlist manifest does not support this Web platform' }, async () => {
  const root = makeTempDir('grant-host')
  try {
    const profile = join(root, 'profile'); mkdirSync(profile)
    const file = join(profile, 'approval-allowlist/grants.json'), rule = grant(root)
    writeGrantsFile(file, [rule])
    const events = [{ type: 'tool/call', data: { callId: 'c1', name: 'write', arguments: JSON.stringify({ ...rule.arguments, content: 'TOP_SECRET' }) } }]
    const agent = { session: { header: { cwd: root }, ownEvents: () => events } }
    type Definition = { execute: (args: unknown, exec: unknown) => Promise<unknown> }
    const definitions = new Map<string, Definition>()
    let approved = false, asked = 0
    const ctx = createFakeContext({ profileContext: { dir: profile, startedBundles: ['@deepseek-ai/dsh-web-app'] }, agents: { roots: () => [agent] }, tools: { register: (def: Definition & { name: string }) => { definitions.set(def.name, def); return () => definitions.delete(def.name) } }, approval: { request: async () => { asked++; return approved ? 'allowed-once' : 'rejected' } } })
    const logFile = join(root, 'audit.jsonl')
    const disposers: (() => void)[] = []
    Object.assign(ctx, { effect: (body: () => () => void) => { disposers.push(body()) } })
    apply(ctx as unknown as Context, { mode: 'allow', logFile })
    const listener = ctx.listeners.find(entry => entry.event === 'approval/request')!
    const invoke = (toolName = 'write') => listener.handler({ agent, callId: 'c1', toolName }, async () => 'next')
    assert.equal(await invoke(), 'allowed-once')
    assert.equal(await invoke('approval_allow'), 'next')
    assert.equal(await invoke('edit'), 'next')
    assert.ok(!readFileSync(logFile, 'utf8').includes('TOP_SECRET'))
    writeGrantsFile(file, [])
    assert.equal(await invoke(), 'next')
    const exec = { agent, callId: 'manage', signal: new AbortController().signal }
    const input = { rule: JSON.stringify(grant(root)) }
    await assert.rejects(definitions.get('approval_allow')!.execute(input, exec), /not approved/)
    assert.equal(new GrantStore(file).read().length, 0)
    approved = true
    const result = JSON.parse(String(await definitions.get('approval_allow')!.execute(input, exec)))
    assert.equal(asked, 2)
    assert.equal(await invoke(), 'allowed-once')
    await definitions.get('approval_revoke')!.execute({ id: result.id }, exec)
    assert.equal(await invoke(), 'next')
    await assert.rejects(definitions.get('approval_list')!.execute({}, { ...exec, agent: undefined }), /root agent/)
    let answer: (value: string) => void = () => {}
    ctx.services.set('approval', { request: () => new Promise<string>(resolve => { answer = resolve }) })
    const pending = definitions.get('approval_allow')!.execute(input, exec)
    for (const dispose of disposers) dispose()
    answer('allowed-once')
    await assert.rejects(pending, /abort/i)
    assert.equal(new GrantStore(file).read().length, 0)
    ctx.services.delete('agents')
    await assert.rejects(definitions.get('approval_allow')!.execute(input, exec), /root agent/)
  } finally { removeDir(root) }
})
