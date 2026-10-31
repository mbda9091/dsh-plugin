import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environmentCase, environmentTest as it, snapshot, sourceRoot } from '../../harness/environment.js'
import type { fixture } from '../../harness/environment.js'
import { targetPackages, installOptions, deliveryReport } from '../../harness/targets.js'
import { prepareIsolation } from '../../harness/isolation.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { inspectTarget } from '../../../../scripts/.build/core/formal-target.js'
import { runArtifactInstall } from '../../../../scripts/.build/commands/install-artifacts.js'
import { runVerifyArtifacts } from '../../../../scripts/.build/commands/verify-artifacts.js'
import { runToFilesAsync } from '../../../../scripts/.build/core/exec.js'
import { ensurePnpmShim, initProfile, runDsh, serveAndCheck } from '../../../../scripts/.build/core/web-harness.js'
import type { WebHarness } from '../../../../scripts/.build/core/web-harness.js'
import { runTarget } from '../../../../scripts/.build/commands/target.js'
import { readPackage } from '../../../../scripts/.build/core/artifact-package.js'
import { checkFixtureCapabilities } from '../../harness/fixture-capability.js'

async function prepare(f: ReturnType<typeof fixture>, names: string[]) {
  const prepared = prepareIsolation(f, true)
  const host = join(f.root, '.formal-host'), preparation = join(f.root, '.formal-preparation'), home = join(f.root, '.formal-home')
  mkdirSync(host); mkdirSync(preparation)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } }))
  writeFileSync(join(host, 'pnpm-workspace.yaml'), readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8').replace(/packages:\r?\n(?:  .*\r?\n)+/, 'packages: []\n'))
  const env: NodeJS.ProcessEnv = { ...prepared.env, CI: 'true' }
  for (const key of Object.keys(env)) if (/^(DSH_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key]
  const result = await runToFilesAsync(process.execPath, [process.env.DSH_ENV_TEST_PNPM!, 'install'], {
    cwd: host, env, timeoutMs: 300_000, stdoutPath: join(preparation, 'install.out'), stderrPath: join(preparation, 'install.err') })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const cli = realpathSync(join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  assert.notEqual(cli, realpathSync(join(f.root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')))
  const fields = { dshCli: cli, home, profile: 'web', surface: 'web', platform: process.platform === 'win32' ? 'windows' : 'mac' }
  runTarget('bind', 'simulated', fields, f.root, env)
  const context = loadCommandContext({ target: 'simulated' }, f.root, env, 'target')
  const runner = inspectTarget(context).runner, runDir = join(f.root, '.formal-run'); mkdirSync(runDir)
  const harness: WebHarness = { settings: context, runner, home, runDir, logDir: runDir, options: { timeoutMs: 120000 } }
  ensurePnpmShim(harness); await initProfile(harness, 'initialize-target', home)
  const other = join(home, 'profiles/other'); mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'package.json'), '{"sentinel":true}')
  for (const file of ['session.sentinel', 'credentials.sentinel']) writeFileSync(join(home, file), 'simulated data only')
  const set = targetPackages(f.root, names)
  assert.equal(await runVerifyArtifacts({ manifest: set.path, keep: false }, loadCommandContext({}, f.root, env, 'test'), checkFixtureCapabilities), 0)
  return { context, harness, set, host, home, other, preparation, env }
}
function assertUnchangedOutsideProfile(before: Record<string, string>, after: Record<string, string>) {
  const filter = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith('./profiles/web/')))
  assert.deepEqual(filter(after), filter(before))
}

it('TGT-04 independent real Node host receives accepted bytes with only selected profile and declared caches changed', { timeout: 600000 }, () => environmentCase('TGT-04', async f => {
  const t = await prepare(f, ['alpha']), homeBefore = snapshot(t.home), hostBefore = snapshot(t.host), developmentBefore = snapshot(join(f.root, '.local/dsh-dev'))
  let report = ''
  assert.equal(await runArtifactInstall({ ...installOptions(t.set.path), dryRun: true }, t.context), 0)
  assert.deepEqual(snapshot(t.home), homeBefore)
  assert.equal(await runArtifactInstall(installOptions(t.set.path), t.context, p => { report = p }), 0)
  const delivery = deliveryReport(report)
  assert.equal(delivery.packages[0]!.sha256, t.set.manifest.packages[0]!.sha256)
  assert.equal(delivery.packages[0]!.row, 'configured'); assert.equal(delivery.packages[0]!.loaded, 'unconfirmed')
  assertUnchangedOutsideProfile(homeBefore, snapshot(t.home)); assert.deepEqual(snapshot(t.host), hostBefore)
  assert.deepEqual(snapshot(join(f.root, '.local/dsh-dev')), developmentBefore)
  await serveAndCheck(t.harness, 'manual-test-start', async (_url, stderr) => { assert.doesNotMatch(stderr, /did not activate|@local\//); return 'isolated target HTTP ready, no activation failure' })
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'TGT-04-details.json'), JSON.stringify({ delivery, separateCli: t.harness.runner.source, selectedProfileOnly: true, hostUnchanged: true, developmentUnchanged: true, explicitTestStart: true }, null, 2))
}, false))

it('TGT-05-real real add overwrites link and old tarball and update removes residual source resolution', { timeout: 600000 }, () => environmentCase('TGT-05-real', async f => {
  const t = await prepare(f, ['alpha']), source = join(f.root, '.old-source')
  const bytes = readFileSync(join(t.set.path, '..', t.set.manifest.packages[0]!.path)), pkg = readPackage(bytes)
  for (const [file, content] of pkg.files) { const path = join(source, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
  const before = snapshot(source)
  await runDsh(t.harness, 'install-old-link', ['plugin', '--profile', 'web', 'add', source], t.home)
  assert.equal(realpathSync(join(t.home, 'profiles/web/node_modules/@local/alpha')), realpathSync(source))
  let report = ''
  assert.equal(await runArtifactInstall(installOptions(t.set.path), t.context, p => { report = p }), 0)
  assert.notEqual(deliveryReport(report).packages[0]!.actual, realpathSync(source)); assert.deepEqual(snapshot(source), before)
  // Repeat against an existing tarball spec, retaining the exact accepted bytes.
  assert.equal(await runArtifactInstall(installOptions(t.set.path), t.context, p => { report = p }), 0)
  assert.deepEqual(snapshot(source), before)
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'TGT-05-real-details.json'), JSON.stringify(deliveryReport(report), null, 2))
}, false))

it('TGT-06-real real first package survives an injected second-consumer failure with no rollback or restart', { timeout: 600000 }, () => environmentCase('TGT-06-real', async f => {
  const t = await prepare(f, ['alpha', 'beta', 'gamma'])
  // Deterministic failure at the real CLI boundary; no production test bypass.
  const hook = join(f.root, '.fail-second.cjs')
  writeFileSync(hook, "if(process.argv.includes('add')&&process.argv.some(x=>x.endsWith('local-beta-1.0.0.tgz'))){console.error('injected second consumer failure');process.exit(17)}")
  const context = { ...t.context, env: { ...t.context.env, NODE_OPTIONS: `--require ${JSON.stringify(hook)}` } }
  let report = ''
  assert.equal(await runArtifactInstall(installOptions(t.set.path), context, p => { report = p }), 1)
  const delivery = deliveryReport(report)
  assert.deepEqual(delivery.packages.map(p => p.status), ['installed', 'failed', 'not-attempted'])
  assert.equal(delivery.packages[0]!.bundle, 'registered'); assert.equal(delivery.packages[0]!.loaded, 'unconfirmed')
  assert.ok(existsSync(delivery.packages[0]!.actual!))
  assert.ok(delivery.packages.every(p => p.capability === 'unverified'))
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'TGT-06-real-details.json'), JSON.stringify(delivery, null, 2))
}, false))
