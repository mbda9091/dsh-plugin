import { workspaceDshVersion } from '../../harness/dsh-version.js'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { environmentCase, environmentTest as it, fixture, snapshot, sourceRoot } from '../../harness/environment.js'
import { dailyFixture } from '../../harness/daily.js'
import { isolationWorker, prepareIsolation } from '../../harness/isolation.js'
import { launchDevelopment } from '../../harness/development.js'
import { targetPackages, installOptions, deliveryReport } from '../../harness/targets.js'
import { checkFixtureCapabilities } from '../../harness/fixture-capability.js'
import { runToFilesAsync, stopChild } from '../../../../scripts/.build/core/exec.js'
import { runTarget } from '../../../../scripts/.build/commands/target.js'
import { runArtifactInstall } from '../../../../scripts/.build/commands/install-artifacts.js'
import { runVerifyArtifacts } from '../../../../scripts/.build/commands/verify-artifacts.js'
import { publishDaily } from '../../../../scripts/.build/commands/daily-launcher.js'
import { dailyHash } from '../../../../scripts/.build/core/daily-contract.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { inspectTarget } from '../../../../scripts/.build/core/formal-target.js'
import { ensurePnpmShim, initProfile, runDsh } from '../../../../scripts/.build/core/web-harness.js'
import type { WebHarness } from '../../../../scripts/.build/core/web-harness.js'
import { stopDevelopment } from '../../../../scripts/.build/core/development-process.js'
import { runWeb } from '../../../../scripts/.build/commands/web.js'

it('DLY-05 real archived migration survives repository loss and coexists with development and disposable hosts', { timeout: 900000 }, () => environmentCase('DLY-05', async outer => {
  const f = fixture(outer.root), prepared = prepareIsolation(f, true), d = dailyFixture(outer.root)
  const pnpm = process.env.DSH_ENV_TEST_PNPM!
  const host = join(outer.root, 'installed-host'); mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': workspaceDshVersion } }))
  writeFileSync(join(host, 'pnpm-workspace.yaml'), readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8').replace(/packages:\r?\n(?:  .*\r?\n)+/, 'packages: []\n'))
  const env: NodeJS.ProcessEnv = { ...prepared.env, CI: 'true' }
  for (const key of Object.keys(env)) if (/^(DSH_|NODE_OPTIONS$|ELECTRON_)/i.test(key)) delete env[key]
  const installed = await runToFilesAsync(process.execPath, [pnpm, 'install'], { cwd: host, env, timeoutMs: 300000, stdoutPath: join(outer.root, 'install.out'), stderrPath: join(outer.root, 'install.err') })
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  const cli = realpathSync(join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  runTarget('bind', 'daily', { dshCli: cli, home: d.home, profile: 'web', surface: 'web', platform: 'windows' }, f.root, env)
  const context = loadCommandContext({ target: 'daily' }, f.root, env, 'target')
  const harness: WebHarness = { settings: context, runner: inspectTarget(context).runner, home: d.home, runDir: join(outer.root, 'formal'), logDir: join(outer.root, 'formal/logs'), options: { timeoutMs: 120000 } }
  rmSync(join(d.home, 'profiles/web/package.json'))
  ensurePnpmShim(harness); await initProfile(harness, 'init', d.home)
  const set = targetPackages(f.root, ['alpha'])
  assert.equal(await runVerifyArtifacts({ manifest: set.path, keep: false }, loadCommandContext({}, f.root, prepared.env, 'test'), checkFixtureCapabilities), 0)
  const source = join(f.root, '.old-source')
  for (const [file, bytes] of set.packages.get('@local/alpha')!.files) { mkdirSync(join(source, file, '..'), { recursive: true }); writeFileSync(join(source, file), bytes) }
  await runDsh(harness, 'old-link', ['plugin', '--profile', 'web', 'add', source], d.home)
  const sourceBefore = snapshot(source), sentinel = readFileSync(join(d.home, 'history.sentinel'), 'utf8')
  const archiveRoot = join(d.external, 'artifacts'); let reportPath = ''
  assert.equal(await runArtifactInstall({ ...installOptions(set.path), archiveRoot }, context, p => { reportPath = p }), 0)
  const report = deliveryReport(reportPath), pkg = report.packages[0]!
  assert.deepEqual(snapshot(source), sourceBefore)
  assert.equal(dailyHash(readFileSync(pkg.archive!)), pkg.sha256)
  d.config.host = { ...d.config.host, cli, entry: cli, hashes: { [d.config.host.node]: d.config.host.hashes[d.config.host.node]!, [cli]: dailyHash(readFileSync(cli)) } }
  d.config.packageManager = { script: realpathSync(pnpm), version: '11.28.5', sha256: dailyHash(readFileSync(pnpm)) }
  d.config.web.startupTimeoutMs = 60000
  d.config.isolation.forbiddenRoots.push(f.root)
  publishDaily(d.candidate, d.external, d.config)
  const checked = await d.command(['check']); assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  const daily = await d.start()
  try {
    // The development fixture's unowned sentinel is removed before its normal init.
    rmSync(join(f.root, '.local/dsh-dev'), { recursive: true })
    f.config.web.startupTimeoutMs = 60000; f.write()
    const dev = await launchDevelopment(f.root, prepared.env)
    const isolated = await isolationWorker(f.root, prepared, 'parallel', 'hold')
    try {
      const ready = await isolated.ready()
      const dailyRuntime = JSON.parse(readFileSync(join(d.external, 'state', d.config.instanceId, 'runtime.json'), 'utf8'))
      assert.notEqual(ready.home, d.home); assert.notEqual(ready.url, dailyRuntime.url)
      assert.equal((await d.command(['status'])).status, 0)
      await stopDevelopment(dev.context); await stopChild(dev.started.child)
      assert.equal(await runWeb(['reset', '--yes'], f.root, prepared.env), 0)
      const failed = await (await isolationWorker(f.root, prepared, 'failure', 'check-fail')).finish()
      assert.equal(failed.ok, false)
      assert.equal((await d.command(['status'])).status, 0)
    } finally {
      isolated.release(); await isolated.finish()
      try { await stopDevelopment(dev.context) } catch { /* reset already removed the stopped owner */ }
      await stopChild(dev.started.child)
    }
  } finally { await d.stop(daily) }
  renameSync(f.root, f.root + '-offline'); renameSync(d.repo, d.repo + '-offline')
  assert.equal((await d.command(['check'])).status, 0)
  await d.stop(await d.start())
  const module = await import(pathToFileURL(join(pkg.actual!, 'lib/index.js')).href)
  let handler: (() => string) | undefined
  module.apply({ on: (_event: string, callback: () => string) => { handler = callback } })
  assert.equal(handler?.(), 'alpha')
  assert.equal(readFileSync(join(d.home, 'history.sentinel'), 'utf8'), sentinel)
  assert.equal(dailyHash(readFileSync(pkg.archive!)), pkg.sha256)
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'DLY-05-details.json'), JSON.stringify({ report, launcher: d.built, tools: { node: process.version, pnpm: '11.28.5', dsh: workspaceDshVersion }, platform: 'windows', surface: 'web', repositoryOffline: true, realCapability: 'alpha handler response', coexistence: ['daily', 'development', 'disposable'], failedTestAndResetPreserveDaily: true }, null, 2))
}, false))
