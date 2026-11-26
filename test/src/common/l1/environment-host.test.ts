import assert from 'node:assert/strict'
import { it as test, mock } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireEnvironmentHost, assertEnvironmentHostEvidence, EnvironmentHostError, environmentHostCases, supportsSharedEnvironmentHost } from "../../../../scripts/.build/core/environment-host.js"
import { runToFilesAsync } from "../../../../scripts/.build/core/exec.js"
import { OwnedProcesses } from "../../../../scripts/.build/core/owned-processes.js"
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

const it = supportsSharedEnvironmentHost() ? test : test.skip
test('shared host: Windows retains isolated fixtures; POSIX enables sharing', () => {
  assert.equal(supportsSharedEnvironmentHost('win32'), false)
  assert.equal(supportsSharedEnvironmentHost('darwin'), true)
  assert.equal(supportsSharedEnvironmentHost('linux'), true)
})

function fixture() {
  const root = makeTempDir('shared-host'), runDir = join(root, '.tmp/run-one')
  const write = (path: string, bytes: string) => { const dest = join(root, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes) }
  mkdirSync(runDir, { recursive: true })
  write('package.json', JSON.stringify({ packageManager: 'pnpm@11.28.5', devDependencies: { '@deepseek-ai/dsh': '1.2.3' } }))
  write('pnpm-lock.yaml', 'root lock one')
  write('pnpm-workspace.yaml', 'packages:\n  - "*"\nnodeLinker: hoisted\n')
  write('pnpm/package.json', '{"name":"pnpm","version":"11.28.5"}')
  write('pnpm/bin/pnpm.cjs', `
    const fs=require('node:fs'),path=require('node:path');
    if(process.argv[2]==='config'){
      console.log(JSON.stringify({ignoreScripts:process.env.pnpm_config_ignore_scripts||'false',
        fileSettings:fs.existsSync(process.env.HOST_CONFIG_FILE||'')?fs.readFileSync(process.env.HOST_CONFIG_FILE,'utf8'):'',
        globalPnpmfile:process.env.HOST_HOOK_FILE,
        storeDir:process.env.pnpm_config_store_dir,'//registry/:_authToken':process.env.HOST_SECRET||'fixture-secret'}));
      process.exit(0);
    }
    fs.appendFileSync(process.env.HOST_INSTALL_TRACE,JSON.stringify({cwd:process.cwd(),store:process.env.pnpm_config_store_dir})+'\\n');
    if(fs.existsSync(process.env.HOST_FAIL))process.exit(13);
    const version=JSON.parse(fs.readFileSync('package.json')).dependencies['@deepseek-ai/dsh'];
    const pkg='node_modules/@deepseek-ai/dsh';fs.mkdirSync(pkg+'/lib',{recursive:true});
    fs.writeFileSync(pkg+'/package.json',JSON.stringify({name:'@deepseek-ai/dsh',version,bin:{dsh:'lib/bin.js'}}));
    fs.writeFileSync(pkg+'/lib/bin.js','console.log('+JSON.stringify(version)+')');
    fs.writeFileSync('pnpm-lock.yaml','installed lock '+version);
    fs.writeFileSync('build-setting',process.env.pnpm_config_ignore_scripts||'false');
    if(process.env.HOST_WORKER_SCRIPT){
      const child=require('node:child_process').spawn(process.execPath,[process.env.HOST_WORKER_SCRIPT,process.cwd()],{stdio:'ignore',detached:process.env.HOST_WORKER_DETACHED==='true'});child.unref();
    }
  `)
  const directory = join(root, '.local/environment-tests'), host = join(directory, 'host')
  const trace = join(root, 'installs.jsonl'), fail = join(root, 'fail')
  const options = { root, runDir, pnpmScript: join(root, 'pnpm/bin/pnpm.cjs'),
    env: { ...process.env, HOST_INSTALL_TRACE: trace, HOST_FAIL: fail, pnpm_config_store_dir: join(root, 'system-store') } }
  const installs = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  return { root, runDir, write, directory, host, trace, fail, options, installs }
}

it('shared host: one preparation, new run reuses indefinitely, plugin changes do not reinstall', async () => {
  const f = fixture()
  try {
    const first = await acquireEnvironmentHost(f.options)
    assert.equal(first.evidence.mode, 'prepared'); assert.equal(first.evidence.installCount, 1)
    // Independent mutable data is removed while the lease and host stay alive.
    const homes = ['a', 'b', 'c'].map(id => join(f.runDir, id))
    for (const home of homes) { mkdirSync(home); rmSync(home, { recursive: true }); first.verify() }
    assert.ok(existsSync(first.evidence.entry)); await first.close()
    assert.equal(first.evidence.released, true); assert.equal(first.evidence.unchanged, true)
    f.write('plugins/notify-web/src/index.ts', 'changed plugin')
    const secondRun = join(f.root, '.tmp/run-two'); mkdirSync(secondRun)
    const second = await acquireEnvironmentHost({ ...f.options, runDir: secondRun })
    assert.equal(second.evidence.mode, 'reused'); assert.equal(second.evidence.installCount, 0)
    assert.equal(second.evidence.host, first.evidence.host); await second.close()
    assert.equal(f.installs().length, 1)
    assert.equal(f.installs()[0].store, f.options.env.pnpm_config_store_dir, 'system package store must be inherited')
    assert.ok(!existsSync(join(f.directory, 'host.lock')))
  } finally { removeDir(f.root) }
})

for (const change of ['root-lock', 'workspace', 'version', 'pnpm', 'ready', 'missing-entry', 'host-lockfile'] as const) {
  it(`shared host: ${change} invalidates cached preparation`, async () => {
    const f = fixture()
    try {
      const first = await acquireEnvironmentHost(f.options); await first.close()
      if (change === 'root-lock') f.write('pnpm-lock.yaml', 'root lock two')
      if (change === 'workspace') f.write('pnpm-workspace.yaml', 'packages: []\nnodeLinker: hoisted\n# changed')
      if (change === 'version') f.write('package.json', JSON.stringify({ packageManager: 'pnpm@11.28.5', devDependencies: { '@deepseek-ai/dsh': '2.0.0' } }))
      if (change === 'pnpm') writeFileSync(f.options.pnpmScript, readFileSync(f.options.pnpmScript, 'utf8') + '\n// changed tool')
      if (change === 'ready') f.write('.local/environment-tests/ready.json', '{broken')
      if (change === 'missing-entry') rmSync(first.evidence.entry)
      if (change === 'host-lockfile') f.write('.local/environment-tests/host/pnpm-lock.yaml', 'replaced')
      const secondRun = join(f.root, '.tmp/run-two'); mkdirSync(secondRun)
      const second = await acquireEnvironmentHost({ ...f.options, runDir: secondRun })
      assert.equal(second.evidence.mode, 'prepared'); assert.equal(second.evidence.installCount, 1); await second.close()
      assert.equal(f.installs().length, 2)
    } finally { removeDir(f.root) }
  })
}

it('shared host: installation failure cannot publish ready and releases its lock for retry', async () => {
  const f = fixture()
  try {
    writeFileSync(f.fail, 'fail')
    await assert.rejects(acquireEnvironmentHost(f.options), error => {
      assert.ok(error instanceof EnvironmentHostError)
      assert.match(error.message, /install failed/)
      assert.equal(error.evidence.installCount, 1)
      assert.equal(error.evidence.host, f.host)
      assert.equal(error.evidence.status, 'failed')
      assert.equal(error.evidence.released, true)
      return true
    })
    assert.ok(!existsSync(join(f.directory, 'ready.json'))); assert.ok(!existsSync(join(f.directory, 'host.lock')))
    rmSync(f.fail)
    const next = join(f.root, '.tmp/run-two'); mkdirSync(next)
    const lease = await acquireEnvironmentHost({ ...f.options, runDir: next }); await lease.close()
    assert.equal(f.installs().length, 2)
  } finally { removeDir(f.root) }
})

it('shared host: mutation fails verification, invalidates ready and still releases the lease', async () => {
  const f = fixture()
  try {
    const lease = await acquireEnvironmentHost(f.options)
    writeFileSync(join(f.host, 'mutation'), 'unexpected')
    await assert.rejects(lease.close(), /modified shared host/)
    assert.equal(lease.evidence.status, 'failed'); assert.equal(lease.evidence.released, true)
    assert.ok(!existsSync(join(f.directory, 'ready.json'))); assert.ok(!existsSync(join(f.directory, 'host.lock')))
  } finally { removeDir(f.root) }
})

it('shared host: another process cannot use or replace a live leased host', async () => {
  const f = fixture()
  try {
    const lease = await acquireEnvironmentHost(f.options)
    const entry = join(f.root, 'competitor.mjs')
    writeFileSync(entry, `import {acquireEnvironmentHost} from ${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/.build/core/environment-host.js')).href)};
      try {await acquireEnvironmentHost(${JSON.stringify(f.options)});process.exitCode=9} catch(e) {console.error(e.message);process.exitCode=7}`)
    const result = await runToFilesAsync(process.execPath, [entry], { cwd: f.root, timeoutMs: 10_000,
      stdoutPath: join(f.runDir, 'competitor.out'), stderrPath: join(f.runDir, 'competitor.err') })
    assert.equal(result.status, 7); assert.match(result.stderr, /host locked/)
    assert.equal(f.installs().length, 1); lease.verify(); await lease.close()
  } finally { removeDir(f.root) }
})

it('shared host: unowned directories and redirected roots are never removed', async () => {
  const f = fixture(), other = makeTempDir('shared-host-protected')
  try {
    mkdirSync(f.directory, { recursive: true }); writeFileSync(join(f.directory, 'sentinel'), 'keep')
    await assert.rejects(acquireEnvironmentHost(f.options), /unowned data/)
    assert.equal(readFileSync(join(f.directory, 'sentinel'), 'utf8'), 'keep')
    rmSync(f.directory, { recursive: true })
    symlinkSync(other, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(acquireEnvironmentHost(f.options), /path is a link/)
    assert.deepEqual(readdirSync(other), [])
  } finally { removeDir(f.root); removeDir(other) }
})

it('shared host: reports must prove release, unchanged files and one independent home per selected case', async () => {
  const f = fixture()
  try {
    const lease = await acquireEnvironmentHost(f.options)
    lease.evidence.users = [{ id: 'TGT-04', home: join(f.runDir, 'a') }, { id: 'TGT-05-real', home: join(f.runDir, 'b') }]
    assert.throws(() => assertEnvironmentHostEvidence(lease.evidence, f.runDir, ['TGT-04', 'TGT-05-real']), /failed shared host evidence/)
    await lease.close()
    assert.doesNotThrow(() => assertEnvironmentHostEvidence(lease.evidence, f.runDir, ['TGT-04', 'TGT-05-real']))
    for (const invalid of [{ ...lease.evidence, unchanged: false }, { ...lease.evidence, installCount: 3 },
      { ...lease.evidence, users: [lease.evidence.users[0], lease.evidence.users[0]] },
      { ...lease.evidence, users: [{ id: 'TGT-04', home: f.root }, lease.evidence.users[1]] }]) {
      assert.throws(() => assertEnvironmentHostEvidence(invalid, f.runDir, ['TGT-04', 'TGT-05-real']), /failed shared host evidence/)
    }
  } finally { removeDir(f.root) }
})

for (const failWrite of [1, 2]) {
  it(`shared host: exclusive ${failWrite === 1 ? 'lock' : 'owner'} write failure leaves no partial file`, async () => {
    const f = fixture(), original = fs.writeFileSync
    let writes = 0
    const mocked = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof writeFileSync>) => {
      if (typeof args[0] === 'number' && ++writes === failWrite) throw Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' })
      return original(...args)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(acquireEnvironmentHost(f.options), /disk full fixture/)
      assert.ok(!existsSync(join(f.directory, 'host.lock')))
      assert.ok(!existsSync(join(f.directory, 'owner.json')))
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); removeDir(f.root) }
  })
}

it('shared host: case drain waits actual work and serializes queued cases after caller timeout', async () => {
  const cases = environmentHostCases(), events: string[] = []
  let finish!: () => void
  const body = new Promise<void>(resolve => { finish = resolve })
  const first = cases.run(async () => { events.push('start'); await body; events.push('finished') })
  const second = cases.run(async () => { events.push('next') })
  const drain = cases.drain().then(() => { events.push('release') })
  await Promise.resolve()
  assert.deepEqual(events, ['start'])
  finish(); await Promise.all([first, second, drain])
  assert.deepEqual(events, ['start', 'finished', 'next', 'release'])
})

it('shared host: real node:test timeout retains lock until its async body has finished', async () => {
  const f = fixture()
  try {
    const entry = join(f.root, 'timeout.mjs'), evidence = join(f.root, 'timeout-result.json')
    writeFileSync(entry, `
      import {it,after} from 'node:test'; import fs from 'node:fs';
      import {acquireEnvironmentHost,environmentHostCases} from ${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/.build/core/environment-host.js')).href)};
      const lease=await acquireEnvironmentHost(${JSON.stringify(f.options)}),cases=environmentHostCases(),events=[];
      it('intentional timeout',{timeout:20},()=>cases.run(async()=>{
        events.push('start');await new Promise(r=>setTimeout(r,100));
        events.push(fs.existsSync(${JSON.stringify(join(f.directory, 'host.lock'))})?'lock-held':'lock-missing');
        events.push('body-finished');
      }));
      after(async()=>{await cases.drain();await lease.close();events.push('released');fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(events))});
    `)
    const result = await runToFilesAsync(process.execPath, ['--test', '--test-isolation=none', entry], { cwd: f.root, timeoutMs: 10000,
      stdoutPath: join(f.runDir, 'timeout.out'), stderrPath: join(f.runDir, 'timeout.err') })
    assert.equal(result.status, 1, 'intentional timeout must fail, never pass')
    assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), ['start', 'lock-held', 'body-finished', 'released'])
    assert.ok(!existsSync(join(f.directory, 'host.lock')))
  } finally { removeDir(f.root) }
})

it('shared host: unlock failure cannot report passed or released', async () => {
  const f = fixture()
  try {
    const lease = await acquireEnvironmentHost(f.options), original = fs.unlinkSync
    const mocked = mock.method(fs, 'unlinkSync', (path: Parameters<typeof fs.unlinkSync>[0]) => {
      if (path === join(f.directory, 'host.lock')) throw new Error('lock unlink fixture')
      return original(path)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(lease.close(), /lock unlink fixture/)
      assert.equal(lease.evidence.status, 'failed'); assert.equal(lease.evidence.released, false)
      assert.match(lease.evidence.error ?? '', /lock unlink fixture/)
      assert.ok(existsSync(join(f.directory, 'host.lock')))
    } finally { mocked.mock.restore(); syncBuiltinESMExports() }
  } finally { removeDir(f.root) }
})

it('shared host: failed lock initialization reports an unreleased lock if unlink also fails', async () => {
  const f = fixture(), originalWrite = fs.writeFileSync, originalUnlink = fs.unlinkSync
  const writing = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof writeFileSync>) => {
    if (typeof args[0] === 'number') throw new Error('lock write fixture')
    return originalWrite(...args)
  })
  const unlinking = mock.method(fs, 'unlinkSync', (path: Parameters<typeof fs.unlinkSync>[0]) => {
    if (path === join(f.directory, 'host.lock')) throw new Error('lock unlink fixture')
    return originalUnlink(path)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(acquireEnvironmentHost(f.options), error => {
      assert.ok(error instanceof EnvironmentHostError)
      assert.equal(error.evidence.status, 'failed'); assert.equal(error.evidence.released, false)
      assert.match(error.message, /lock write fixture/); assert.match(error.message, /lock unlink fixture/)
      return true
    })
    assert.ok(existsSync(join(f.directory, 'host.lock')))
  } finally { writing.mock.restore(); unlinking.mock.restore(); syncBuiltinESMExports(); removeDir(f.root) }
})

it('shared host: the runner preserves failed preparation proof in its final report', async () => {
  const f = fixture()
  try {
    cpSync(join(repoRoot, 'scripts/.build'), join(f.root, 'scripts/.build'), { recursive: true })
    cpSync(join(repoRoot, 'scripts/src'), join(f.root, 'scripts/src'), { recursive: true })
    for (const path of ['scripts/dev.mjs', 'scripts/install.mjs', 'scripts/launch.mjs', 'scripts/bootstrap.mjs',
      'scripts/config/schema.json', 'scripts/config/schema.v1.json', 'test/src/common/harness/environment.ts',
      'test/src/common/harness/development.ts', 'test/src/common/harness/isolation.ts', 'profiles/web/cordis.dev.patch.yml']) {
      f.write(path, readFileSync(join(repoRoot, path), 'utf8'))
    }
    f.write('package.json', JSON.stringify({ type: 'module', packageManager: 'pnpm@11.28.5' }))
    f.write('node_modules/typescript/package.json', '{"version":"test-fixture"}')
    f.write('node_modules/typescript/bin/tsc', '')
    // Only report orchestration is under test; no real host or acceptance is faked as passed.
    f.write('test/.build-env/common/environment/real/proof.test.js', `
      import {it} from 'node:test';import fs from 'node:fs';import path from 'node:path';
      it('TGT-04 preparation failed',()=>{
        fs.writeFileSync(path.join(process.env.DSH_ENV_TEST_RUN,'shared-host.json'),JSON.stringify({version:1,status:'failed',installCount:1,host:'known-host',error:'install failed fixture'}));
        throw new Error('install failed fixture');
      });
    `)
    f.write('entry.mjs', `import {runTestEnv} from './scripts/.build/commands/test-env.js';process.exitCode=await runTestEnv('real',false,${JSON.stringify(f.options.pnpmScript)},'TGT-04');`)
    const result = await runToFilesAsync(process.execPath, [join(f.root, 'entry.mjs')], { cwd: f.root, timeoutMs: 10000,
      stdoutPath: join(f.runDir, 'runner.out'), stderrPath: join(f.runDir, 'runner.err') })
    assert.equal(result.status, 1)
    const base = join(f.root, '.tmp/environment-tests'), run = readdirSync(base)[0]!
    const report = JSON.parse(readFileSync(join(base, run, 'report.json'), 'utf8'))
    assert.equal(report.status, 'failed')
    assert.equal(report.sharedHost.installCount, 1)
    assert.equal(report.sharedHost.host, 'known-host')
    assert.equal(report.sharedHost.error, 'install failed fixture')
  } finally { removeDir(f.root) }
})

for (const source of ['environment', 'configuration-file'] as const) {
  it(`shared host: effective ${source} installation settings invalidate reuse`, async () => {
    const f = fixture()
    try {
      const configFile = join(f.root, 'user-settings')
      writeFileSync(configFile, 'ignoreScripts: false')
      const env = { ...f.options.env, pnpm_config_ignore_scripts: 'false', HOST_CONFIG_FILE: configFile }
      const first = await acquireEnvironmentHost({ ...f.options, env }); await first.close()
      const runDir = join(f.root, '.tmp/run-two'); mkdirSync(runDir)
      if (source === 'environment') env.pnpm_config_ignore_scripts = 'true'
      else writeFileSync(configFile, 'ignoreScripts: true')
      const second = await acquireEnvironmentHost({ ...f.options, env, runDir })
      assert.equal(second.evidence.mode, 'prepared')
      assert.notEqual(second.evidence.configFingerprint, first.evidence.configFingerprint)
      assert.notEqual(second.evidence.fingerprint, first.evidence.fingerprint)
      await second.close(); assert.equal(f.installs().length, 2)
      if (source === 'environment') assert.equal(readFileSync(join(f.host, 'build-setting'), 'utf8'), 'true')
    } finally { removeDir(f.root) }
  })
}

it('shared host: authentication and store changes do not leak values or rebuild valid contents', async () => {
  const f = fixture()
  try {
    const first = await acquireEnvironmentHost({ ...f.options, env: { ...f.options.env, HOST_SECRET: 'private-first-value' } }); await first.close()
    const runDir = join(f.root, '.tmp/run-two'); mkdirSync(runDir)
    const second = await acquireEnvironmentHost({ ...f.options, runDir,
      env: { ...f.options.env, HOST_SECRET: 'private-second-value', pnpm_config_store_dir: join(f.root, 'other-system-store') } })
    assert.equal(second.evidence.mode, 'reused'); await second.close()
    const all = [f.runDir, runDir].flatMap(run => readdirSync(join(run, 'shared-host')).map(name => readFileSync(join(run, 'shared-host', name), 'utf8'))).join('\n')
    assert.ok(!all.includes('private-first-value')); assert.ok(!all.includes('private-second-value'))
    assert.ok(!JSON.stringify(second.evidence).includes('private-second-value'))
  } finally { removeDir(f.root) }
})

it('shared host: hook content changes at the same configured path invalidate reuse', async () => {
  const f = fixture(), hook = join(f.root, 'pnpm-hook.cjs')
  try {
    writeFileSync(hook, 'module.exports={hooks:{}}')
    const env = { ...f.options.env, HOST_HOOK_FILE: hook }
    const first = await acquireEnvironmentHost({ ...f.options, env }); await first.close()
    writeFileSync(hook, 'module.exports={hooks:{readPackage(pkg){return pkg}}}')
    const runDir = join(f.root, '.tmp/run-two'); mkdirSync(runDir)
    const second = await acquireEnvironmentHost({ ...f.options, env, runDir })
    assert.notEqual(second.evidence.configFingerprint, first.evidence.configFingerprint)
    assert.equal(second.evidence.mode, 'prepared'); await second.close()
  } finally { removeDir(f.root) }
})

it('shared host: detached installer writes remain outside the published host', async () => {
  const f = fixture(), worker = join(f.root, 'detached-worker.cjs'), marker = join(f.root, 'worker-finished')
  try {
    writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path');setTimeout(()=>{try{fs.writeFileSync(path.join(process.argv[2],'late-write'),'stale')}catch{}fs.writeFileSync(${JSON.stringify(marker)},'done')},800)`)
    const lease = await acquireEnvironmentHost({ ...f.options, env: { ...f.options.env, HOST_WORKER_SCRIPT: worker, HOST_WORKER_DETACHED: 'true' } })
    assert.notEqual(f.installs()[0].cwd, lease.evidence.host)
    assert.equal(lease.evidence.isolatedInstallation, true)
    await lease.close()
    const runDir = join(f.root, '.tmp/run-two'); mkdirSync(runDir)
    const next = await acquireEnvironmentHost({ ...f.options, runDir })
    await new Promise(resolve => setTimeout(resolve, 900))
    assert.equal(readFileSync(marker, 'utf8'), 'done')
    assert.equal(existsSync(join(next.evidence.host, 'late-write')), false)
    await next.close()
  } finally { removeDir(f.root) }
})

it('shared host: validates the published copy when a late installer adds an external link', async () => {
  const f = fixture(), original = fs.lstatSync
  let visits = 0
  let restore = () => {}
  try {
    const outside = join(f.root, 'outside'); writeFileSync(outside, 'not host data')
    const mocked = mock.method(fs, 'lstatSync', ((path, ...args) => {
      if (typeof path === 'string' && basename(path).startsWith('shared-host-install-') && ++visits === 2) {
        symlinkSync(outside, join(path, 'late-external-link'))
      }
      return original(path, ...args)
    }) as typeof fs.lstatSync)
    restore = () => mocked.mock.restore()
    syncBuiltinESMExports()
    await assert.rejects(acquireEnvironmentHost(f.options), /nonportable link/)
    assert.equal(existsSync(join(f.directory, 'ready.json')), false)
    assert.equal(existsSync(join(f.directory, 'host.lock')), false)
  } finally { restore(); syncBuiltinESMExports(); removeDir(f.root) }
})

it('shared host: an installer descendant cannot write after the host is released and rebuilt', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    const worker = join(f.root, 'worker.cjs')
    writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path');setTimeout(()=>fs.writeFileSync(path.join(process.argv[2],'stale-worker'),'old-installer'),600)`)
    const first = await acquireEnvironmentHost({ ...f.options, env: { ...f.options.env, HOST_WORKER_SCRIPT: worker } }); await first.close()
    f.write('pnpm-lock.yaml', 'new lock')
    const runDir = join(f.root, '.tmp/run-two'); mkdirSync(runDir)
    const second = await acquireEnvironmentHost({ ...f.options, runDir })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.ok(!existsSync(join(f.host, 'stale-worker')))
    await second.close(); assert.equal(second.evidence.status, 'passed')
  } finally { removeDir(f.root) }
})

it('shared host: preparation cleanup failure retains the lock and blocks a competing acquisition', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(), processes = new OwnedProcesses(), original = process.kill
  let mocked: ReturnType<typeof mock.method<typeof process, 'kill'>> | undefined
  try {
    const worker = join(f.root, 'worker.cjs'); writeFileSync(worker, 'setInterval(()=>{},1000)')
    mocked = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && existsSync(f.trace)) throw Object.assign(new Error('fixture cannot confirm process tree'), { code: 'EPERM' })
      return original(pid, signal)
    })
    await assert.rejects(acquireEnvironmentHost({ ...f.options, processes, env: { ...f.options.env, HOST_WORKER_SCRIPT: worker } }), error => {
      assert.ok(error instanceof EnvironmentHostError)
      assert.equal(error.evidence.released, false); assert.equal(error.evidence.installCount, 1)
      return true
    })
    assert.ok(existsSync(join(f.directory, 'host.lock')))
    await assert.rejects(acquireEnvironmentHost(f.options), /host locked/)
  } finally { mocked?.mock.restore(); await processes.settle(); removeDir(f.root) }
})

it('shared host: caught command cleanup failure still prevents lease release', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(), processes = new OwnedProcesses(), original = process.kill
  let mocked: ReturnType<typeof mock.method<typeof process, 'kill'>> | undefined
  try {
    const lease = await acquireEnvironmentHost({ ...f.options, processes })
    mocked = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) throw Object.assign(new Error('fixture cleanup denied'), { code: 'EPERM' })
      return original(pid, signal)
    })
    await assert.rejects(processes.run(() => runToFilesAsync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: f.root, timeoutMs: 20, stdoutPath: join(f.runDir, 'active.out'), stderrPath: join(f.runDir, 'active.err'),
    })), /fixture cleanup denied/)
    await assert.rejects(lease.close(), /tree exit is unconfirmed/)
    assert.equal(lease.evidence.released, false); assert.equal(lease.evidence.status, 'failed')
    await assert.rejects(acquireEnvironmentHost(f.options), /host locked/)
  } finally { mocked?.mock.restore(); await processes.settle(); removeDir(f.root) }
})
