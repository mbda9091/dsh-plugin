import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { environmentTest as it } from '../../harness/environment.js'
import { environmentCase, snapshot, sourceRoot } from '../../harness/environment.js'
import { isolationWorker, prepareIsolation } from '../../harness/isolation.js'
import { stopChild } from '../../../../scripts/.build/core/exec.js'

it('ISO-01-real locked host isolates DSH data and pnpm inherits shared system settings', { timeout: 180_000 }, () => environmentCase('ISO-01-real', async f => {
  const prepared = prepareIsolation(f, true), before = snapshot(prepared.development)
  const report = await (await isolationWorker(f.root, prepared, 'real', 'probe')).finish()
  assert.equal(report.ok, true)
  assert.ok(report.steps.some((s: { name: string; ok: boolean }) => s.name === 'pnpm-config' && s.ok))
  assert.deepEqual(snapshot(prepared.development), before)
  assert.equal(existsSync(report.home), false)
}, false))

it('ISO-02-real repeated and concurrent hosts have distinct data and ports', { timeout: 240_000 }, () => environmentCase('ISO-02-real', async f => {
  const prepared = prepareIsolation(f, true)
  const first = await (await isolationWorker(f.root, prepared, 'first')).finish(); assert.equal(first.ok, true)
  const workers = await Promise.all(['a', 'b'].map(id => isolationWorker(f.root, prepared, id, 'hold')))
  try {
    const ready = await Promise.all(workers.map(w => w.ready()))
    assert.notEqual(ready[0].url, ready[1].url); assert.notEqual(ready[0].home, ready[1].home)
    assert.ok(ready.every(r => r.home !== first.home))
    const envs = ['a', 'b'].map(id => JSON.parse(readFileSync(join(f.root, `${id}.env.json`), 'utf8')))
    assert.equal(envs[0].store, envs[1].store)
    assert.equal(envs[0].store, join(prepared.shared, 'pnpm-store'))
    workers.forEach(w => w.release())
    assert.ok((await Promise.all(workers.map(w => w.finish()))).every(r => r.ok))
  } finally { workers.forEach(w => w.release()); await Promise.all(workers.map(w => stopChild(w.started.child))) }
}, false))

it('ISO-03 real lifecycle success keep startup install timeout and handled interrupt retain truthful reports', { timeout: 300_000 }, () => environmentCase('ISO-03', async f => {
  const prepared = prepareIsolation(f, true)
  const other = createServer((_req, res) => res.end('unrelated'))
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
  const address = other.address(); assert.ok(address && typeof address !== 'string')
  const evidence = []
  try {
    for (const mode of ['success', 'keep', 'start-fail', 'install-fail', 'timeout', 'interrupt']) {
      const report = await (await isolationWorker(f.root, prepared, mode, mode)).finish()
      assert.equal(report.ok, ['success', 'keep'].includes(mode), JSON.stringify(report))
      if (mode === 'timeout') { assert.equal(report.steps.at(-1).name, 'serve'); assert.match(report.steps.at(-1).detail, /within 1ms/) }
      if (report.home) assert.equal(existsSync(report.home), mode !== 'success')
      assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'unrelated')
      evidence.push({ mode, report: join(report.runDir, 'report.json'), cleanup: report.cleanup })
    }
  } finally { await new Promise<void>((resolve, reject) => other.close(error => error ? reject(error) : resolve())) }
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'ISO-03-details.json'), JSON.stringify(evidence, null, 2))
}, false))

it('ISO-05 declared CI matrix uses shared environment and functional gate with locked real host', { timeout: 180_000 }, () => environmentCase('ISO-05', async f => {
  const workflow = readFileSync(join(sourceRoot, '.github/workflows/tests.yml'), 'utf8')
  assert.match(workflow, /windows-latest, macos-latest/)
  assert.match(workflow, /node-version: '24'/); assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.doesNotMatch(workflow, /(?:npm|pnpm) (?:install|add).*global.*(?:@deepseek-ai\/dsh| dsh)/)
  assert.match(workflow, /node scripts\/bootstrap.mjs ci/)
  const ci = readFileSync(join(sourceRoot, 'scripts/src/commands/ci.ts'), 'utf8')
  assert.match(ci, /assertEnvironmentResults/); assert.match(ci, /runTestEnv\('all'/)
  const prepared = prepareIsolation(f, true)
  const report = await (await isolationWorker(f.root, prepared, 'runner')).finish(); assert.equal(report.ok, true)
  // Missing locked entry is a context failure with a report, never a PATH fallback.
  f.config.tools.pnpmScript = 'missing'; f.write()
  const failure = await (await isolationWorker(f.root, prepared, 'wrong-tool')).finish(); assert.equal(failure.ok, false)
  // Clean frozen checkout is TOOL-04. Platform-wide function results are referenced
  // by the enclosing CI report; this case does not label unexecuted platforms passed.
}, false))
