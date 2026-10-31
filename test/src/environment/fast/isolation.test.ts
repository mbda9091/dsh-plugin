import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environmentTest as it } from '../../harness/environment.js'
import { environmentCase, snapshot, sourceRoot } from '../../harness/environment.js'
import { isolationWorker, prepareIsolation } from '../../harness/isolation.js'
import { freshTestHome } from '../../../../scripts/.build/core/test-isolation.js'
import { runToFiles, stopChild } from '../../../../scripts/.build/core/exec.js'
import { assertEnvironmentResults } from '../../../../scripts/.build/core/environment-results.js'
import { runIsolatedTest } from '../../../../scripts/.build/core/test-run.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { digest } from '../../../../scripts/.build/core/config-transaction.js'

it('ISO-01 child DSH destinations are isolated while system package settings are shared', () => environmentCase('ISO-01', async f => {
  const prepared = prepareIsolation(f), before = snapshot(prepared.development), parent = { ...process.env }
  const worker = await isolationWorker(f.root, prepared, 'one')
  const report = await worker.finish(); assert.equal(report.ok, true)
  const env = JSON.parse(readFileSync(join(f.root, 'one.env.json'), 'utf8'))
  assert.equal(env.home, report.home); assert.equal(env.profile, join(report.home, 'profiles/web'))
  assert.equal(env.store, join(prepared.shared, 'pnpm-store')); assert.equal(env.userconfig, join(prepared.shared, 'npmrc'))
  assert.ok(existsSync(prepared.shared), 'test cleanup must preserve shared package data')
  assert.equal(env.patch, undefined); assert.equal(env.web, undefined)
  assert.equal(digest(JSON.stringify({ ...process.env })), digest(JSON.stringify(parent)), 'parent environment unchanged'); assert.deepEqual(snapshot(prepared.development), before)
  assert.equal(existsSync(report.home), false); assert.ok(existsSync(join(report.runDir, 'report.json')))
}))

it('ISO-02 unsafe homes rejected and independent processes own distinct homes stores and ports', () => environmentCase('ISO-02', async f => {
  const prepared = prepareIsolation(f), scratch = join(f.root, '.tmp'); mkdirSync(scratch)
  assert.equal(freshTestHome(f.root, scratch, '.tmp/new-home'), join(scratch, 'new-home'))
  for (const path of [scratch, f.personal, join(f.root, '.local/dsh-dev/new')]) assert.throws(() => freshTestHome(f.root, scratch, path), /new directory/)
  symlinkSync(f.personal, join(scratch, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => freshTestHome(f.root, scratch, join(scratch, 'escape/new')), /without links/)
  const workers = await Promise.all(['a', 'b'].map(id => isolationWorker(f.root, prepared, id, 'hold')))
  try {
    const ready = await Promise.all(workers.map(w => w.ready()))
    assert.notEqual(ready[0].home, ready[1].home); assert.notEqual(ready[0].url, ready[1].url)
    workers.forEach(w => w.release())
    const reports = await Promise.all(workers.map(w => w.finish())); assert.ok(reports.every(r => r.ok))
    const next = await (await isolationWorker(f.root, prepared, 'c')).finish()
    assert.equal(next.ok, true); assert.ok(reports.every(r => r.runDir !== next.runDir))
  } finally { await Promise.all(workers.map(w => stopChild(w.started.child))) }
}))

it('ISO-04 fast CLI works with broken disk config no plugin lib browser or real host', () => environmentCase('ISO-04', f => {
  for (const path of ['scripts/src', 'scripts/bootstrap.mjs', 'scripts/tsconfig.json', 'test/src/environment', 'test/src/harness', 'test/tsconfig.environment.json', 'test/tsconfig.json', 'tsconfig.base.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'profiles/web/cordis.dev.patch.yml', '.gitignore']) {
    cpSync(join(sourceRoot, path), join(f.root, path), { recursive: true })
  }
  mkdirSync(join(f.root, 'node_modules/@types'), { recursive: true })
  for (const name of ['typescript', '@types/node', 'undici-types']) symlinkSync(join(sourceRoot, 'node_modules', name), join(f.root, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(f.paths.local, '{broken'); const before = readFileSync(f.paths.local)
  const result = runToFiles(process.execPath, [join(f.root, 'scripts/bootstrap.mjs'), 'test-env', '--suite', 'fast', '--only', 'CFG-01'], {
    cwd: f.personal, env: { ...process.env, DSH_CLI: 'missing', DSH_PNPM: '', CHROME_PATH: 'missing' }, timeoutMs: 60_000,
    stdoutPath: join(f.root, 'cli.out'), stderrPath: join(f.root, 'cli.err'),
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(readFileSync(f.paths.local), before)
  assert.equal(existsSync(join(f.root, 'notify-web/lib')), false)
}))

it('ISO-06 missing skipped incomplete unwritable reports and cleanup failures never pass; tokens redacted', () => environmentCase('ISO-06', async f => {
  const path = join(f.root, 'report.json')
  assert.throws(() => assertEnvironmentResults(path, ['X']), /ENOENT/)
  const good = { status: 'passed', started: new Date().toISOString(), results: [{ id: 'X', status: 'pass', evidence: 'X.json' }] }
  writeFileSync(join(f.root, 'X.json'), JSON.stringify({ id: 'X', passed: true, cleanup: 'removed owned fixture' }))
  for (const report of [{ ...good, results: [] }, { ...good, results: [{ ...good.results[0], status: 'skip' }] }, { ...good, results: [...good.results, ...good.results] }]) {
    writeFileSync(path, JSON.stringify(report)); assert.throws(() => assertEnvironmentResults(path, ['X']))
  }
  writeFileSync(path, JSON.stringify(good)); assert.doesNotThrow(() => assertEnvironmentResults(path, ['X']))
  const prepared = prepareIsolation(f)
  const failed = await (await isolationWorker(f.root, prepared, 'redaction', 'check-fail')).finish()
  assert.equal(failed.ok, false); assert.ok(existsSync(failed.home))
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_TOKEN|FAKE_BEARER/)
  const context = loadCommandContext({}, f.root, prepared.env, 'test')
  const code = await runIsolatedTest('cleanup-test', context, { keep: false, timeoutMs: 1000 }, async c => {
    const escape = join(c.runDir, 'workspace'); symlinkSync(f.personal, escape, process.platform === 'win32' ? 'junction' : 'dir')
  })
  assert.equal(code, 1)
  const report = JSON.parse(readFileSync(join(f.root, '.tmp/cleanup-test/last-report.json'), 'utf8'))
  assert.match(report.cleanup, /failed/); assert.equal(report.steps.at(-1).name, 'cleanup')
  await assert.rejects(runIsolatedTest('write-fail', context, { keep: true, timeoutMs: 1000 }, async c => {
    mkdirSync(join(c.runDir, 'report.json'))
  }), /EISDIR|EPERM|EACCES/)
}))
