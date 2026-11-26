import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import fs, { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { cleanupEnvironmentTests, FAILURE_RETENTION_MS, finishEnvironmentCleanup, keepEnvironmentPaths, startEnvironmentCleanup, usesEnvironmentPaths, withTestWorkLock } from '../../../scripts/.build/core/test-storage.js'
import { resolveDsh } from '../../../scripts/.build/core/dsh-cli.js'
import { runToFilesAsync, sleep } from '../../../scripts/.build/core/exec.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

function fixture() {
  const root = makeTempDir('test-storage'), run = join(root, '.tmp/environment-tests/run-one')
  const home = join(run, 'repo 中文 space-one/.formal-home'), dependencies = join(run, 'repo 中文 space-one/node_modules')
  mkdirSync(home, { recursive: true }); mkdirSync(dependencies)
  writeFileSync(join(home, 'temporary-data'), 'disposable')
  writeFileSync(join(run, 'report.json'), '{"historical":"unchanged"}')
  startEnvironmentCleanup(root, run, false)
  const finish = (status: 'passed' | 'failed' = 'failed', complete = true) => finishEnvironmentCleanup(root, run, status, complete)
  const ended = () => Date.parse(JSON.parse(readFileSync(join(run, 'cleanup-state.json'), 'utf8')).ended)
  return { root, run, home, dependencies, finish, ended }
}

it('test cleanup: seven-day boundary deletes data but preserves the run and report bytes', async () => {
  const f = fixture()
  try {
    f.finish()
    const report = readFileSync(join(f.run, 'report.json'))
    assert.equal((await cleanupEnvironmentTests(f.root, true, f.ended() + FAILURE_RETENTION_MS - 1)).items[0]!.action, 'retain')
    assert.ok(existsSync(f.home))
    const result = await cleanupEnvironmentTests(f.root, true, f.ended() + FAILURE_RETENTION_MS)
    assert.equal(result.status, 'passed'); assert.equal(result.items.filter(item => item.removed).length, 2)
    assert.equal(existsSync(f.home), false); assert.equal(existsSync(f.dependencies), false)
    assert.deepEqual(readFileSync(join(f.run, 'report.json')), report)
    assert.ok(existsSync(join(f.run, 'cleanup-state.json')))
    assert.ok((await cleanupEnvironmentTests(f.root, true)).items.every(item => !item.removed))
  } finally { removeDir(f.root) }
})

it('test cleanup: preview is read-only and success leftovers are immediately eligible', async () => {
  const f = fixture()
  try {
    f.finish('passed')
    const before = readFileSync(join(f.run, 'cleanup-state.json'))
    const preview = await cleanupEnvironmentTests(f.root, false)
    assert.equal(preview.status, 'preview'); assert.ok(preview.items.every(item => item.action === 'remove' && !item.removed))
    assert.ok(existsSync(f.home)); assert.deepEqual(readFileSync(join(f.run, 'cleanup-state.json')), before)
    assert.equal(existsSync(join(f.root, '.tmp/environment-tests/last-cleanup.json')), false)
    assert.equal(existsSync(join(f.root, '.tmp/test-work.lock')), false)
    assert.equal((await cleanupEnvironmentTests(f.root, true)).status, 'passed')
    assert.equal(existsSync(f.home), false)
  } finally { removeDir(f.root) }
})

for (const state of ['keep', 'unfinished', 'legacy', 'invalid-owner', 'escape', 'future'] as const) {
  it(`test cleanup: ${state} is retained without touching data`, async () => {
    const f = fixture()
    try {
      f.finish('passed', state !== 'unfinished')
      const path = join(f.run, 'cleanup-state.json'), record = JSON.parse(readFileSync(path, 'utf8'))
      if (state === 'keep') record.keep = true
      if (state === 'invalid-owner') record.root = f.run
      if (state === 'escape') record.paths.push('../../must-not-delete')
      if (state === 'future') record.ended = new Date(Date.now() + 100000).toISOString()
      if (state === 'legacy') rmSync(path); else writeFileSync(path, JSON.stringify(record))
      const result = await cleanupEnvironmentTests(f.root, true)
      assert.equal(result.status, 'passed'); assert.equal(result.items[0]!.action === 'remove', false)
      assert.ok(existsSync(f.home)); assert.ok(existsSync(f.dependencies))
    } finally { removeDir(f.root) }
  })
}

it('test cleanup: evidence mixed with data is retained; no package cache or linked target is followed', async () => {
  const f = fixture(), external = makeTempDir('test-storage-external')
  try {
    writeFileSync(join(f.home, 'report.json'), '{"proof":true}')
    rmSync(f.dependencies, { recursive: true }); symlinkSync(external, f.dependencies, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(external, 'sentinel'), 'external package data')
    mkdirSync(join(f.root, '.local/environment-tests/host'), { recursive: true })
    writeFileSync(join(f.root, '.local/environment-tests/host/sentinel'), 'reusable host')
    f.finish('passed')
    const result = await cleanupEnvironmentTests(f.root, true)
    assert.equal(result.status, 'passed'); assert.ok(existsSync(join(f.home, 'report.json')))
    assert.equal(existsSync(f.dependencies), false)
    assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'external package data')
    assert.equal(readFileSync(join(f.root, '.local/environment-tests/host/sentinel'), 'utf8'), 'reusable host')
  } finally { removeDir(f.root); removeDir(external) }
})

for (const name of ['manifest.json', 'acceptance.report.json', 'node-trace.jsonl']) {
  it(`test cleanup: ${name} keeps its containing temporary data`, async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.home, name), '{"diagnostic":true}')
      f.finish('passed')
      const result = await cleanupEnvironmentTests(f.root, true)
      assert.equal(result.status, 'passed'); assert.ok(existsSync(join(f.home, name)))
      assert.ok(result.items.some(item => item.path === f.home && item.action === 'retain'))
    } finally { removeDir(f.root) }
  })
}

it('test cleanup: the actual private fixture pnpm-store is collected', async () => {
  const f = fixture(), store = join(f.run, 'repo 中文 space-one/.shared-package/pnpm-store')
  try {
    mkdirSync(store, { recursive: true }); writeFileSync(join(store, 'package-bytes'), 'private cold data')
    f.finish('passed')
    const result = await cleanupEnvironmentTests(f.root, true)
    assert.ok(result.items.some(item => item.path === store && item.removed)); assert.equal(existsSync(store), false)
  } finally { removeDir(f.root) }
})

it('test cleanup: a handled in-process L4 interruption cannot publish a normal environment finish', async () => {
  const f = fixture()
  const write = (path: string, value: string) => { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), value) }
  try {
    cpSync(join(repoRoot, 'scripts/.build'), join(f.root, 'scripts/.build'), { recursive: true })
    cpSync(join(repoRoot, 'scripts/src'), join(f.root, 'scripts/src'), { recursive: true })
    for (const path of ['scripts/dev.mjs', 'scripts/install.mjs', 'scripts/launch.mjs', 'scripts/bootstrap.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'scripts/config/schema.json', 'scripts/config/schema.v1.json', 'test/src/harness/environment.ts', 'test/src/harness/development.ts', 'test/src/harness/isolation.ts', 'profiles/web/cordis.dev.patch.yml']) {
      write(path, readFileSync(join(repoRoot, path), 'utf8'))
    }
    write('package.json', readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    write('node_modules/typescript/package.json', '{"version":"fixture"}'); write('node_modules/typescript/bin/tsc', '')
    mkdirSync(join(f.root, 'node_modules/@deepseek-ai'), { recursive: true })
    symlinkSync(join(repoRoot, 'node_modules/@deepseek-ai/dsh'), join(f.root, 'node_modules/@deepseek-ai/dsh'), process.platform === 'win32' ? 'junction' : 'dir')
    write('test/.build-env/environment/fast/interrupt.test.js', `
      import {it} from 'node:test';import fs from 'node:fs';import path from 'node:path';
      import {runIsolatedTest} from '../../../../scripts/.build/core/test-run.js';
      import {loadCommandContext} from '../../../../scripts/.build/core/command-context.js';
      it('CFG-01 handled interruption',async()=>{
        const run=process.env.DSH_ENV_TEST_RUN;
        const home=path.join(run,'repo 中文 space-signal/.formal-home');fs.mkdirSync(home,{recursive:true});
        await runIsolatedTest('l4',loadCommandContext({},process.cwd(),process.env,'test'),{keep:false,timeoutMs:5000},async c=>{process.emit('SIGINT');c.signal.throwIfAborted()});
        fs.writeFileSync(path.join(run,'CFG-01.json'),JSON.stringify({id:'CFG-01',passed:false,cleanup:'retained failure'}));
        throw new Error('handled interruption fixture');
      });`)
    write('entry.mjs', "import {runTestEnv} from './scripts/.build/commands/test-env.js';process.exitCode=await runTestEnv('fast',false,undefined,'CFG-01')")
    const result = await runToFilesAsync(process.execPath, [join(f.root, 'entry.mjs')], { cwd: f.root, timeoutMs: 15000,
      stdoutPath: join(f.root, 'runner.out'), stderrPath: join(f.root, 'runner.err') })
    assert.equal(result.status, 1)
    const base = join(f.root, '.tmp/environment-tests'), name = readdirSync(base).find(name => name !== 'run-one')!
    const record = JSON.parse(readFileSync(join(base, name, 'cleanup-state.json'), 'utf8'))
    assert.equal(record.complete, false); assert.equal(record.status, 'failed')
    const retained = await cleanupEnvironmentTests(f.root, true, Date.now() + 100 * FAILURE_RETENTION_MS)
    assert.ok(retained.items.some(item => item.path === join(base, name) && item.reason === 'unfinished or exit unconfirmed'))
    assert.ok(existsSync(join(base, name, 'repo 中文 space-signal/.formal-home')))
  } finally { removeDir(f.root) }
})

it('test cleanup: replaced ancestors fail closed and do not delete external data', async () => {
  const f = fixture(), external = makeTempDir('test-storage-ancestor')
  try {
    f.finish('passed')
    const directory = join(f.run, 'repo 中文 space-one')
    rmSync(directory, { recursive: true }); mkdirSync(join(external, '.formal-home'))
    symlinkSync(external, directory, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await cleanupEnvironmentTests(f.root, true)).status, 'failed')
    assert.ok(existsSync(join(external, '.formal-home')))
  } finally { removeDir(f.root); removeDir(external) }
})

it('test cleanup: one work lock skips cleanup during tests and lets tests wait for cleanup', async () => {
  const f = fixture()
  try {
    await withTestWorkLock(f.root, 'test', async () => {
      assert.equal((await cleanupEnvironmentTests(f.root, true)).status, 'skipped')
      await assert.rejects(withTestWorkLock(f.root, 'test', async () => {}), /locked/)
    })
    const order: string[] = []
    let waiting: Promise<unknown> | undefined
    await withTestWorkLock(f.root, 'cleanup', async () => {
      waiting = withTestWorkLock(f.root, 'test', async () => { order.push('test') })
      await sleep(150); assert.equal(order.length, 0); order.push('cleanup')
    })
    await waiting; assert.deepEqual(order, ['cleanup', 'test'])
    assert.equal(existsSync(join(f.root, '.tmp/test-work.lock')), false)
  } finally { removeDir(f.root) }
})

it('test cleanup: cancelled waiting does not remove another command lock', async () => {
  const f = fixture(), controller = new AbortController()
  try {
    await withTestWorkLock(f.root, 'cleanup', async () => {
      const pending = withTestWorkLock(f.root, 'test', async () => assert.fail('must not run'), controller.signal)
      controller.abort(new Error('cancelled fixture'))
      await assert.rejects(pending, /cancelled fixture/)
      assert.ok(existsSync(join(f.root, '.tmp/test-work.lock')))
    })
  } finally { removeDir(f.root) }
})

it('test cleanup: explicit historical home is kept before it is created', async () => {
  const f = fixture()
  try {
    f.finish('passed')
    keepEnvironmentPaths(f.root, [join(f.run, 'new-explicit-home')])
    assert.equal(JSON.parse(readFileSync(join(f.run, 'cleanup-state.json'), 'utf8')).keep, true)
    f.finish('failed') // A later report must not erase the user's/pinner's keep.
    assert.equal((await cleanupEnvironmentTests(f.root, true, Date.now() + 100 * FAILURE_RETENTION_MS)).items[0]!.reason, 'keep')
    assert.ok(existsSync(f.home)); assert.equal(existsSync(join(f.run, 'new-explicit-home')), false)
  } finally { removeDir(f.root) }
})

it('test cleanup: symlink consumer aliases and new children of aliases select the same protected run', () => {
  const f = fixture()
  try {
    f.finish('passed')
    const cli = join(f.home, 'dsh.cjs'), alias = join(f.root, 'outside-dsh.cjs'), directory = join(f.root, 'outside-home')
    writeFileSync(cli, 'console.log("fixture")'); symlinkSync(cli, alias)
    symlinkSync(f.run, directory, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(usesEnvironmentPaths(f.root, [alias]), true)
    assert.equal(usesEnvironmentPaths(f.root, [join(directory, 'not-created-yet')]), true)
    assert.equal(usesEnvironmentPaths(f.root, [join(f.root, 'ordinary-user-home')]), false)
    keepEnvironmentPaths(f.root, [alias])
    assert.equal(JSON.parse(readFileSync(join(f.run, 'cleanup-state.json'), 'utf8')).keep, true)
  } finally { removeDir(f.root) }
})

it('test cleanup: a recognized Windows shim protects its resolved Node entry, not just the wrapper', () => {
  const f = fixture()
  try {
    f.finish('passed')
    const entry = join(f.home, 'dsh.cjs'), shim = join(f.root, 'external-dsh.cmd')
    writeFileSync(entry, 'console.log("fixture")')
    writeFileSync(shim, `@echo off\n"%_prog%" "${entry}" %*\n`)
    const runner = resolveDsh({ env: { ...process.env, DSH_CLI: shim }, platform: 'win32' })
    assert.equal(usesEnvironmentPaths(f.root, [shim]), false)
    assert.equal(usesEnvironmentPaths(f.root, [shim, ...runner.build([])]), true)
    keepEnvironmentPaths(f.root, [shim, ...runner.build([])])
    assert.equal(JSON.parse(readFileSync(join(f.run, 'cleanup-state.json'), 'utf8')).keep, true)
  } finally { removeDir(f.root) }
})

it('test cleanup: the common lock is atomically published with a complete ownership record', async () => {
  const f = fixture(), original = fs.linkSync
  let published = false
  const mocked = mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    assert.equal(JSON.parse(readFileSync(args[0], 'utf8')).kind, 'test')
    assert.equal(existsSync(args[1]), false); published = true
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await withTestWorkLock(f.root, 'test', async () => assert.equal(JSON.parse(readFileSync(join(f.root, '.tmp/test-work.lock'), 'utf8')).kind, 'test'))
    assert.equal(published, true)
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); removeDir(f.root) }
})

it('test cleanup: a failed removal stops the pass, reports failure and can be retried', async () => {
  const f = fixture(), original = fs.rmSync
  try {
    f.finish('passed')
    const mocked = mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
      if (args[0] === f.home) throw new Error('fixture permission denied')
      return original(...args)
    })
    syncBuiltinESMExports()
    try {
      const result = await cleanupEnvironmentTests(f.root, true)
      assert.equal(result.status, 'failed'); assert.match(result.error!, /permission denied/)
      assert.ok(existsSync(f.home))
      assert.equal(JSON.parse(readFileSync(join(f.root, '.tmp/environment-tests/last-cleanup.json'), 'utf8')).status, 'failed')
    } finally { mocked.mock.restore(); syncBuiltinESMExports() }
    assert.equal((await cleanupEnvironmentTests(f.root, true)).status, 'passed')
    assert.equal(existsSync(f.home), false)
  } finally { removeDir(f.root) }
})
