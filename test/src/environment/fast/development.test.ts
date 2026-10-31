import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { it } from 'node:test'
import { runWeb } from '../../../../scripts/.build/commands/web.js'
import { acquireDevelopmentLock, assertSeparatePaths, developmentPaths, readDevelopmentOwner, recordDevelopmentLinks, validateDevelopmentPaths } from '../../../../scripts/.build/core/development.js'
import { developmentStatus, stopDevelopment } from '../../../../scripts/.build/core/development-process.js'
import { waitForExit } from '../../../../scripts/.build/core/exec.js'
import { environmentCase, snapshot } from '../../harness/environment.js'
import { launchDevelopment, prepareDevelopment } from '../../harness/development.js'

it('DEV-01 initialization and supervised restart preserve development data', () => environmentCase('DEV-01', async f => {
  const d = prepareDevelopment(f), p = developmentPaths(f.root)
  await runWeb(['init'], f.root, d.env)
  writeFileSync(join(p.home, 'debug-session'), 'retained')
  writeFileSync(p.patch, readFileSync(p.patch, 'utf8') + '\n# developer setting\n')
  const before = snapshot(p.directory)
  await runWeb(['init'], f.root, d.env)
  assert.deepEqual(snapshot(p.directory), before)
  for (let i = 0; i < 2; i++) {
    const { started } = await launchDevelopment(f.root, d.env)
    try { assert.match(await developmentStatus(d.context), /^running/); assert.equal(readFileSync(join(p.home, 'debug-session'), 'utf8'), 'retained') }
    finally { await stopDevelopment(d.context); await waitForExit(started.child, 5000) }
  }
  assert.match(readFileSync(p.patch, 'utf8'), /developer setting/)
  assert.equal(await developmentStatus(d.context), 'stopped')
}))

it('DEV-02 physical paths, aliases and replaced ancestors fail closed', () => environmentCase('DEV-02', async f => {
  const d = prepareDevelopment(f), p = developmentPaths(f.root)
  for (const other of [p.directory, join(p.directory, 'home'), join(f.root, '.local')]) assert.throws(() => assertSeparatePaths(p.directory, other), /overlap/)
  assert.throws(() => assertSeparatePaths(p.directory, join(p.directory, '../dsh-dev/home')), /overlap/)
  assertSeparatePaths(p.directory, p.directory + '-other')
  if (process.platform === 'win32') assert.throws(() => assertSeparatePaths(p.directory, p.directory.toUpperCase()), /overlap/)
  const alias = join(f.root, 'alias')
  symlinkSync(f.personal, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertSeparatePaths(join(alias, 'not-created'), f.personal), /overlap/)
  symlinkSync(f.personal, join(f.root, '.local'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(runWeb(['init'], f.root, d.env), /link/)
  unlinkSync(join(f.root, '.local'))
  await runWeb(['init'], f.root, d.env)
  rmSync(p.home, { recursive: true })
  symlinkSync(f.personal, p.home, process.platform === 'win32' ? 'junction' : 'dir')
  for (const action of ['init', 'reset', 'status']) await assert.rejects(runWeb([action], f.root, d.env), /link/)
  unlinkSync(p.home)
  const overlap = { ...d.context, config: { ...d.context.config, targets: [{ name: 'bad', home: p.home, dshCli: d.entry, profile: 'web', surface: 'web' as const, platform: 'windows' as const }] } }
  assert.throws(() => validateDevelopmentPaths(overlap), /overlap/)
}))

it('DEV-04 duplicate instances, occupied ports, timeout and stale PIDs are safe', () => environmentCase('DEV-04', async f => {
  const d = prepareDevelopment(f), p = developmentPaths(f.root)
  await runWeb(['init'], f.root, d.env)
  const { started } = await launchDevelopment(f.root, d.env)
  try { await assert.rejects(runWeb(['--no-open', '--port', '0'], f.root, d.env), /already recorded/); assert.match(await developmentStatus(d.context), /running/) }
  finally { await stopDevelopment(d.context); await waitForExit(started.child, 5000) }
  const occupied = createServer((_req, res) => res.end('{}'))
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  try {
    const address = occupied.address(); assert.ok(address && typeof address !== 'string')
    await assert.rejects(runWeb(['--no-open', '--port', String(address.port)], f.root, d.env), /occupied/)
    assert.equal(occupied.listening, true)
    const owner = readDevelopmentOwner(d.context)
    writeFileSync(p.runtime, JSON.stringify({ version: 1, owner: owner.id, run: 'old', token: 'old', controlPort: address.port, pid: process.pid, state: 'running' }))
    await assert.rejects(stopDevelopment(d.context), /identity cannot be verified/)
    assert.doesNotThrow(() => process.kill(process.pid, 0))
    assert.ok(existsSync(p.runtime)); unlinkSync(p.runtime)
  } finally { occupied.closeAllConnections?.(); await new Promise<void>(resolve => occupied.close(() => resolve())) }
  const pid = join(f.root, 'timeout-pid')
  await assert.rejects(runWeb(['--no-open', '--port', '0', '--startup-timeout', '700'], f.root, { ...d.env, DEV_FAKE_TIMEOUT: pid }), /did not print a URL/)
  assert.throws(() => process.kill(Number(readFileSync(pid, 'utf8')), 0), /ESRCH/)
  assert.equal(existsSync(p.runtime), false)
  const release = acquireDevelopmentLock(d.context)
  try { assert.throws(() => acquireDevelopmentLock(d.context), /locked/) } finally { release() }
}))

it('DEV-05 reset validates ownership and unlinks only verified source links', () => environmentCase('DEV-05', async f => {
  const d = prepareDevelopment(f), p = developmentPaths(f.root)
  await runWeb(['init'], f.root, d.env)
  const plugin = { packageName: '@local/fixture', dir: join(f.root, 'fixture') }
  mkdirSync(plugin.dir); writeFileSync(join(plugin.dir, 'sentinel'), 'source')
  recordDevelopmentLinks(d.context, [plugin])
  mkdirSync(join(p.profile, 'node_modules/@local'), { recursive: true })
  symlinkSync(plugin.dir, join(p.profile, 'node_modules/@local/fixture'), process.platform === 'win32' ? 'junction' : 'dir')
  const source = snapshot(plugin.dir), before = snapshot(p.directory)
  await runWeb(['reset'], f.root, d.env); assert.deepEqual(snapshot(p.directory), before)
  const owner = readFileSync(p.owner)
  unlinkSync(p.owner)
  await assert.rejects(runWeb(['reset', '--yes'], f.root, d.env), /ownership is missing/)
  writeFileSync(p.owner, owner)
  const wrong = JSON.parse(owner.toString()); wrong.root = f.personal; writeFileSync(p.owner, JSON.stringify(wrong))
  await assert.rejects(runWeb(['init'], f.root, d.env), /ownership does not match/)
  writeFileSync(p.owner, owner)
  symlinkSync(f.personal, join(p.directory, 'unknown'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(runWeb(['reset', '--yes'], f.root, d.env), /unknown external/)
  unlinkSync(join(p.directory, 'unknown'))
  const { started } = await launchDevelopment(f.root, d.env)
  await runWeb(['reset', '--yes'], f.root, d.env); await waitForExit(started.child, 5000)
  assert.equal(existsSync(p.directory), false); assert.deepEqual(snapshot(plugin.dir), source)
  assert.equal(realpathSync(plugin.dir), plugin.dir)
}))

it('DEV-06 dedicated template never imports personal patch; generated data is ignored', () => environmentCase('DEV-06', async f => {
  const d = prepareDevelopment(f), p = developmentPaths(f.root)
  writeFileSync(f.paths.patch, 'not valid YAML: [PERSONAL_PATCH_SENTINEL')
  const before = readFileSync(f.paths.patch)
  await runWeb(['init'], f.root, d.env)
  assert.deepEqual(readFileSync(f.paths.patch), before)
  assert.doesNotMatch(readFileSync(p.patch, 'utf8'), /PERSONAL_PATCH_SENTINEL|credentials/)
  assert.deepEqual(Object.keys(snapshot(p.home)).filter(key => /credentials|session/.test(key)), [])
  const sourceIgnore = readFileSync(join(import.meta.dirname, '../../../../.gitignore'), 'utf8')
  assert.match(sourceIgnore, /^\.local\/$/m)
}))
