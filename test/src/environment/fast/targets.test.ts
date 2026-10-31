import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { environmentCase, environmentTest as it, snapshot } from '../../harness/environment.js'
import { prepareTarget, targetPackages, fakeAcceptance, installOptions, deliveryReport } from '../../harness/targets.js'
import { discoverTargets, inspectTarget } from '../../../../scripts/.build/core/formal-target.js'
import { runTarget } from '../../../../scripts/.build/commands/target.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { runArtifactInstall, deliveryDiagnostics } from '../../../../scripts/.build/commands/install-artifacts.js'
import { runStatus } from '../../../../scripts/.build/commands/status.js'

it('TGT-01 discovery rejects development aliases; binding and path replacement are rechecked', () => environmentCase('TGT-01', f => {
  const t = prepareTarget(f), bin = join(f.root, 'node_modules/.bin'); mkdirSync(bin, { recursive: true })
  const alias = join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (process.platform === 'win32') writeFileSync(alias, `@echo off\n"%_prog%" "${t.entry}" %*\n`)
  else symlinkSync(t.entry, alias, 'file')
  const external = join(t.host, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (process.platform === 'win32') writeFileSync(external, '@echo off\n"%_prog%" "%dp0%\\cli.cjs" %*\n')
  else writeFileSync(external, '#!/usr/bin/env node\n')
  const env = { ...t.env, PATH: [bin, t.host].join(delimiter) }
  const found = discoverTargets(f.root, env)
  assert.ok(found.candidates.some(c => c.path === external)); assert.ok(!found.candidates.some(c => c.path === alias))
  assert.ok(found.rejected.some(c => c.path === alias))
  const before = readFileSync(f.paths.local)
  assert.equal(runTarget('bind', 'daily', { ...t.fields, dryRun: true }, f.root, env), 0)
  assert.deepEqual(readFileSync(f.paths.local), before); assert.equal(existsSync(t.home), false)
  runTarget('bind', 'daily', t.fields, f.root, env)
  const named = () => loadCommandContext({ target: 'daily' }, f.root, env, 'target')
  inspectTarget(named()); runTarget('show', 'daily', {}, f.root, env)
  renameSync(t.host, t.host + '-original'); symlinkSync(dirname(t.entry), t.host, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => inspectTarget(named()), /workspace development/)
  assert.throws(() => runTarget('bind', 'bad', t.fields, f.root, env), /workspace development/)
  assert.equal(existsSync(t.home), false)
  runTarget('unbind', 'daily', {}, f.root, env)
  assert.deepEqual(JSON.parse(readFileSync(f.paths.local, 'utf8')).targets, [])
}))

it('TGT-02 invalid selection platform version coverage and all fail before target writes', () => environmentCase('TGT-02', async f => {
  const t = prepareTarget(f), set = targetPackages(f.root); fakeAcceptance(set)
  for (const flags of [{}, { home: t.home }, { target: 'missing' }, { target: 'missing', ...t.fields }]) assert.throws(() => loadCommandContext(flags, f.root, t.env, 'target'))
  const options = installOptions(set.path)
  for (const change of [{ all: true }, { only: '@local/missing' }, { only: '@local/alpha,@local/alpha' }]) await assert.rejects(runArtifactInstall({ ...options, ...change }, t.context()))
  await assert.rejects(runArtifactInstall(options, { ...t.context(), target: { ...t.context().target!, platform: t.fields.platform === 'windows' ? 'mac' : 'windows' } }), /platform/)
  await assert.rejects(runArtifactInstall(options, { ...t.context(), target: { ...t.context().target!, surface: 'desktop' } }), /surface|compatible/)
  writeFileSync(t.mode, 'version'); await assert.rejects(runArtifactInstall(options, t.context()), /verification/)
  assert.equal(existsSync(t.trace), false); assert.equal(existsSync(t.home), false)
  const profile = join(t.home, 'profiles/web'); mkdirSync(dirname(profile), { recursive: true }); symlinkSync(f.personal, profile, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => inspectTarget(t.context()), /link/)
}))

it('TGT-03 previews do not write targets and execution rechecks config bytes and explicit subsets', () => environmentCase('TGT-03', async f => {
  const t = prepareTarget(f), set = targetPackages(f.root); fakeAcceptance(set)
  const before = readFileSync(f.paths.local), options = { ...installOptions(set.path), only: '@local/alpha' }
  assert.equal(await runArtifactInstall({ ...options, dryRun: true }, t.context()), 0)
  assert.deepEqual(readFileSync(f.paths.local), before); assert.equal(existsSync(t.home), false)
  let report = ''
  assert.equal(await runArtifactInstall(options, t.context(), p => { report = p }), 0)
  assert.deepEqual(deliveryReport(report).packages.map(p => p.status), ['installed', 'skipped', 'skipped'])
  const installed = snapshot(t.home)
  writeFileSync(join(dirname(set.path), set.manifest.packages[0]!.path), 'changed after preview')
  await assert.rejects(runArtifactInstall(options, t.context()), /hash changed/)
  assert.deepEqual(snapshot(t.home), installed)
  const next = targetPackages(f.root); fakeAcceptance(next)
  assert.equal(await runArtifactInstall(installOptions(next.path), t.context(), p => { report = p; writeFileSync(f.paths.local, before.toString() + '\n') }), 1)
  assert.match(deliveryReport(report).error!, /configuration changed/)
  assert.deepEqual(snapshot(t.home), installed)
}))

it('TGT-05 link overwrite reparses without remove and status detects residual source junctions', () => environmentCase('TGT-05', async f => {
  const t = prepareTarget(f), source = join(f.root, 'alpha'); mkdirSync(source); writeFileSync(join(source, 'sentinel'), 'source stays')
  const set = targetPackages(f.root, ['alpha']); fakeAcceptance(set)
  const profile = join(t.home, 'profiles/web'), installed = join(profile, 'node_modules/@local/alpha')
  mkdirSync(dirname(installed), { recursive: true }); symlinkSync(source, installed, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@local/alpha': 'file:old.tgz' }, dsh: { profile: { bundles: ['@local/alpha'] } } }))
  assert.equal(runStatus({ manifest: set.path }, t.context()), 1)
  const before = snapshot(source)
  assert.equal(await runArtifactInstall(installOptions(set.path), t.context()), 0)
  assert.deepEqual(snapshot(source), before); assert.equal(runStatus({ manifest: set.path }, t.context()), 0)
  const calls = readFileSync(t.trace, 'utf8'); assert.doesNotMatch(calls, /remove/); assert.match(calls, /update/)
}))

it('TGT-06 partial failure warnings loading failure and restart remain separate from file delivery', () => environmentCase('TGT-06', async f => {
  const t = prepareTarget(f), set = targetPackages(f.root); fakeAcceptance(set)
  let report = ''; writeFileSync(t.mode, 'second-fails')
  assert.equal(await runArtifactInstall(installOptions(set.path), t.context(), p => { report = p }), 1)
  assert.deepEqual(deliveryReport(report).packages.map(p => p.status), ['installed', 'failed', 'not-attempted'])
  assert.doesNotMatch(readFileSync(t.trace, 'utf8'), /remove/)
  for (const [mode, code, loaded] of [['warning', 1, 'unconfirmed'], ['restart', 0, 'restart-required'], ['load-fail', 1, 'failed']] as const) {
    writeFileSync(t.mode, mode)
    assert.equal(await runArtifactInstall({ ...installOptions(set.path), only: '@local/alpha' }, t.context(), p => { report = p }), code)
    const p = deliveryReport(report).packages[0]!
    assert.equal(p.status, 'installed'); assert.equal(p.loaded, loaded); assert.equal(p.capability, 'unverified')
    if (mode === 'warning') assert.equal(p.warnings.length, 1)
  }
  assert.equal(deliveryDiagnostics('warnings: []\napplication: applied\nenabled').loaded, 'unconfirmed')
}))
