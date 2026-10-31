import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { environmentCase, environmentTest as it, snapshot, sourceRoot } from '../../harness/environment.js'
import { dailyFixture } from '../../harness/daily.js'
import { publishDaily, runDailyLauncher } from '../../../../scripts/.build/commands/daily-launcher.js'
import { initializeConfig } from '../../../../scripts/.build/commands/config.js'
import { runTarget } from '../../../../scripts/.build/commands/target.js'
import { auditDaily, dailyHash, validateDailyTools } from '../../../../scripts/.build/core/daily-contract.js'
import { archiveArtifacts, archiveLocation, saveDailyReceipt } from '../../../../scripts/.build/core/daily-archive.js'
import { artifactFixture, verificationFixture } from '../../harness/artifacts.js'
import { verificationPath } from '../../../../scripts/.build/core/artifact-verification.js'
import { checkDeliveryLock } from '../../../../scripts/.build/commands/install-artifacts.js'

it('DLY-01 deployed launcher starts stops and restarts without repository or pnpm management dependency', { timeout: 90000 }, () => environmentCase('DLY-01', async f => {
  const d = dailyFixture(f.root)
  d.config.web.browserPath = join(d.host, 'missing-browser.exe')
  publishDaily(d.candidate, d.external, d.config)
  renameSync(d.repo, d.repo + '-offline')
  const child = await d.start({ ...process.env, DSH_HOME: 'wrong', DSH_PROFILE_DIR: 'wrong', DSH_PATCH: 'wrong', ELECTRON_RUN_AS_NODE: '1', npm_config_registry: 'https://example.invalid', pnpm_config_store_dir: 'shared-store' })
  try {
    assert.deepEqual(JSON.parse(readFileSync(d.capture, 'utf8')), { cwd: d.home, home: d.home, profile: d.config.target.directory, registry: 'https://example.invalid', store: 'shared-store' })
    renameSync(d.pnpm, d.pnpm + '-missing')
    assert.equal((await d.command(['status'])).status, 0)
  } finally { await d.stop(child) }
  assert.notEqual((await d.command(['--no-open'])).status, 0)
  renameSync(d.pnpm + '-missing', d.pnpm)
  await d.stop(await d.start())
  assert.equal(readFileSync(join(d.home, 'history.sentinel'), 'utf8'), 'original history')
  assert.equal((await d.command(['check'])).status, 0)
}))

it('DLY-02 failed publication preserves previous pointer and rejects drift source links and unsafe destinations', () => environmentCase('DLY-02', async f => {
  const d = dailyFixture(f.root), pointer = join(d.external, 'active.json'), original = readFileSync(pointer, 'utf8')
  assert.throws(() => publishDaily(d.candidate, d.external, d.config, { beforeActivate() { throw new Error('injected publication interruption') } }), /interruption/)
  assert.equal(readFileSync(pointer, 'utf8'), original)
  assert.equal((await d.command(['check'])).status, 0)
  assert.throws(() => publishDaily(d.candidate, join(d.repo, 'bad'), d.config), /overlap/)
  const alias = join(f.root, 'alias'); symlinkSync(d.external, alias, 'junction')
  assert.throws(() => publishDaily(d.candidate, alias, d.config), /link/)
  writeFileSync(d.entry, 'changed host'); assert.throws(() => validateDailyTools(d.config), /bytes changed/)
  const source = join(d.repo, 'alpha'); mkdirSync(source); writeFileSync(join(source, 'package.json'), '{}')
  mkdirSync(join(d.config.target.directory, 'node_modules/@local'), { recursive: true })
  symlinkSync(source, join(d.config.target.directory, 'node_modules/@local/alpha'), 'junction')
  writeFileSync(join(d.config.target.directory, 'package.json'), JSON.stringify({ dependencies: { '@local/alpha': 'file:missing.tgz' } }))
  assert.ok(auditDaily(d.config).findings.some(f => f.reason.includes('forbidden root')))
  writeFileSync(join(d.config.target.directory, 'cordis.patch.yml'), '- id: hmr\n  config: !!js process.env.PATH\n')
  assert.ok(auditDaily(d.config).findings.some(f => f.kind === 'review'))
}))

it('DLY-03 busy port stale record and authentication failure do not stop unrelated listeners', { timeout: 90000 }, () => environmentCase('DLY-03', async f => {
  const d = dailyFixture(f.root), server = createServer((_req, res) => res.writeHead(403).end())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    assert.notEqual((await d.command(['--port', String(address.port), '--no-open'])).status, 0)
    assert.equal(server.listening, true)
    const state = join(d.external, 'state', d.config.instanceId), runtime = join(state, 'runtime.json')
    mkdirSync(state, { recursive: true })
    const record = { version: 1, owner: d.config.instanceId, run: 'old', token: 'wrong', controlPort: address.port, pid: process.pid, state: 'running' }
    writeFileSync(runtime, JSON.stringify(record))
    assert.notEqual((await d.command(['status'])).status, 0)
    assert.notEqual((await d.command(['stop'])).status, 0)
    assert.equal(server.listening, true); assert.ok(existsSync(runtime))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}))

it('DLY-04 external archive preserves evidence rejects collisions and detects stale lock resolutions', () => environmentCase('DLY-04', f => {
  const d = dailyFixture(f.root), set = artifactFixture(d.repo), evidence = verificationFixture(set), path = verificationPath(set, evidence.platform)
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(evidence))
  const archive = join(d.external, 'artifacts'), selected = set.manifest.packages
  assert.throws(() => archiveLocation(d.repo, d.home, join(d.repo, 'archive')), /overlap/)
  assert.throws(() => archiveLocation(d.repo, join(d.repo, 'home'), archive), /overlap/)
  const copies = archiveArtifacts(set, selected, evidence, archive, d.home)
  const copy = copies.get(selected[0]!.name)!
  assert.equal(dailyHash(readFileSync(copy)), selected[0]!.sha256)
  assert.deepEqual(archiveArtifacts(set, selected, evidence, archive, d.home), copies)
  const receipt = saveDailyReceipt(archive, 'run-test', { source: copy, evidence: dailyHash(readFileSync(path)) })
  writeFileSync(copy, 'collision')
  assert.throws(() => archiveArtifacts(set, selected, evidence, archive, d.home), /collision/)
  const name = selected[0]!.name, spec = 'file:' + copy
  const lock = { importers: { '.': { dependencies: { [name]: { specifier: spec, version: 'link:source' } } } } }
  writeFileSync(join(d.config.target.directory, 'pnpm-lock.yaml'), JSON.stringify(lock))
  assert.throws(() => checkDeliveryLock(d.config.target.directory, name, copy), /stale lockfile/)
  renameSync(d.repo, d.repo + '-offline')
  assert.ok(existsSync(receipt)); assert.ok(existsSync(join(archive, set.manifest.batch, 'manifest.json')))
}))

it('DLY-06 prepare and preview do not deploy and explicit deployment can recover the old release', { timeout: 90000 }, () => environmentCase('DLY-06', async f => {
  const d = dailyFixture(f.root), directory = join(d.repo, 'scripts/config')
  mkdirSync(directory, { recursive: true })
  for (const name of ['example.json', 'schema.json']) copyFileSync(join(sourceRoot, 'scripts/config', name), join(directory, name))
  initializeConfig({ pnpmScript: d.pnpm, browser: 'default' }, d.repo, process.env)
  runTarget('bind', 'daily', { dshCli: d.entry, home: d.home, profile: 'web', surface: 'web', platform: 'windows' }, d.repo, process.env)
  const destination = join(f.root, 'command-deployment'), args = ['--target', 'daily', '--destination', destination], before = snapshot(d.repo)
  assert.equal(await runDailyLauncher(['deploy', ...args, '--dry-run'], d.repo), 0)
  assert.deepEqual(snapshot(d.repo), before); assert.equal(existsSync(destination), false)
  assert.equal(await runDailyLauncher(['prepare', ...args], d.repo), 0)
  assert.equal(existsSync(destination), false)
  assert.equal(await runDailyLauncher(['deploy', ...args], d.repo), 0)
  assert.ok(existsSync(join(destination, 'active.json')))
  const pointer = join(d.external, 'active.json'), previous = readFileSync(pointer, 'utf8')
  // A valid JS release can still fail at runtime; recovery uses retained bytes.
  const broken = 'export async function run(){throw Error("injected runtime failure")}\n'
  writeFileSync(join(d.candidate, 'launcher.mjs'), broken)
  const manifest = JSON.parse(readFileSync(join(d.candidate, 'manifest.json'), 'utf8'))
  manifest.release = dailyHash(broken); manifest.files['launcher.mjs'] = manifest.release
  writeFileSync(join(d.candidate, 'manifest.json'), JSON.stringify(manifest))
  publishDaily(d.candidate, d.external, d.config)
  assert.notEqual((await d.command(['check'])).status, 0)
  writeFileSync(pointer, previous)
  await d.stop(await d.start())
}))
