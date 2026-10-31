import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { environmentTest as it } from '../../harness/environment.js'
import { initializeConfig, checkConfig } from '../../../../scripts/.build/commands/config.js'
import { loadRepoConfig, readConfigFile, resolveConfig, validate } from '../../../../scripts/.build/core/config.js'
import { migrateConfig, planMigration } from '../../../../scripts/.build/core/config-migration.js'
import { commitConfig, digest, maintenancePaths, safeConfigPath } from '../../../../scripts/.build/core/config-transaction.js'
import type { TransactionPoint } from '../../../../scripts/.build/core/config-transaction.js'
import { commandEnv, configuredDsh, configuredPnpm, loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { runToFiles, startToFiles, stopChild } from '../../../../scripts/.build/core/exec.js'
import { main } from '../../../../scripts/.build/cli.js'
import { environmentCase, snapshot, sourceRoot } from '../../harness/environment.js'

it('CFG-01 strict v2 schema, defaults only on init, no implicit target', () => environmentCase('CFG-01', async f => {
  assert.equal(initializeConfig({ browser: 'default' }, f.root, {}).state, 'created')
  assert.deepEqual(loadRepoConfig(f.root, {}).config.targets, [])
  assert.deepEqual(checkConfig(f.root, { DSH_CLI: 'ignored' }).warnings, [])
  const baseline = snapshot(f.root)
  assert.throws(() => loadCommandContext({}, f.root, {}, 'target'), /explicit target required/)
  assert.deepEqual(snapshot(f.root), baseline)
  for (const bad of [
    { ...f.config, version: 99 }, { ...f.config, unknown: true }, { ...f.config, tools: {} },
    { ...f.config, targets: [{ name: 'incomplete' }] }, { ...f.config, targets: 'wrong' },
    { ...f.config, web: { ...f.config.web, openBrowser: 'false' } },
    { ...f.config, web: { ...f.config.web, startupTimeoutMs: 0 } },
  ]) { f.write(bad); assert.throws(() => loadRepoConfig(f.root, {}), /local.json/); assert.throws(() => readConfigFile(f.paths.local, f.paths.schema)) }
  writeFileSync(f.paths.local, '{"fake-secret":"do-not-print"')
  assert.throws(() => loadRepoConfig(f.root, {}), e => e instanceof Error && e.message.includes('valid JSON') && !e.message.includes('do-not-print'))
  assert.throws(() => validate({}, { type: 'object', unsupported: true }, 'schema'), /unsupported/)
  f.legacy()
  assert.throws(() => loadRepoConfig(f.root, {}), /config migrate/)
}))

it('CFG-02 command contexts and fake CLI ignore daily destination variables', () => environmentCase('CFG-02', async f => {
  f.write(); const entry = f.fake(); const before = snapshot(f.personal)
  const env = { ...process.env, dsh_cli: 'personal-cli', DSH_HOME: f.personal, dsh_profile: 'daily', DSH_PROFILE_DIR: f.personal, dsh_web_url: 'secret', PNPM_CONFIG_STORE_DIR: f.personal, dsh_pnpm: 'env-pnpm', chrome_path: 'env-browser', dsh_e2e_browser: 'chromium' }
  const saved = { ...env }; const original = readFileSync(f.paths.local)
  for (const purpose of ['tools', 'development', 'test'] as const) {
    const context = loadCommandContext({ pnpmScript: 'flag-pnpm' }, f.root, env, purpose)
    assert.equal(context.config.tools.pnpmScript, join(f.root, 'flag-pnpm'))
    assert.equal(context.config.test.browser, purpose === 'test' ? 'chromium' : 'chrome')
    const child = commandEnv(context)
    assert.equal(child.DSH_CLI, undefined)
    assert.equal(child.DSH_WEB_URL, undefined)
    assert.throws(() => loadCommandContext({ dshCli: entry }, f.root, env, purpose), /not supported/)
    const runner = configuredDsh(context, true)
    const record = join(f.root, `${purpose}.json`)
    const result = runToFiles(runner.command, runner.build([record, 'probe']), { cwd: f.personal, env: child, stdoutPath: join(f.root, 'out'), stderrPath: join(f.root, 'err') })
    assert.equal(result.status, 0)
    const recorded = JSON.parse(readFileSync(record, 'utf8'))
    assert.equal(recorded.node, process.execPath)
    assert.deepEqual(recorded.args, ['probe'])
    assert.equal(recorded.home, purpose === 'development' ? join(f.root, '.local/dsh-dev/home') : undefined)
    assert.notEqual(recorded.store, f.personal)
  }
  const explicit = { dshCli: entry, home: 'chosen-home', profile: 'chosen', surface: 'web', platform: 'windows' }
  const target = loadCommandContext(explicit, f.root, env, 'target')
  assert.equal(target.env.DSH_HOME, join(f.root, 'chosen-home'))
  assert.equal(target.env.DSH_PROFILE, 'chosen')
  assert.throws(() => loadCommandContext({ dshCli: entry }, f.root, env, 'target'), /explicit target required/)
  assert.throws(() => loadCommandContext({ ...explicit, target: 'daily' }, f.root, env, 'target'), /cannot be combined/)
  assert.equal(loadCommandContext({}, f.root, env, 'test').config.tools.pnpmScript, join(f.root, 'env-pnpm'))
  assert.equal(loadCommandContext({ testBrowser: 'chrome' }, f.root, env, 'test').config.test.browser, 'chrome')
  assert.deepEqual(env, saved); assert.deepEqual(readFileSync(f.paths.local), original); assert.deepEqual(snapshot(f.personal), before)
  f.write({ ...f.config, targets: [{ name: 'daily', ...explicit }] })
  const named = loadCommandContext({ target: 'daily' }, f.root, env, 'target')
  assert.equal(named.target?.home, join(f.root, 'chosen-home'))
  assert.throws(() => loadCommandContext({ target: 'absent' }, f.root, env, 'target'), /unknown named target/)
  f.write({ ...f.config, targets: [{ name: 'daily', ...explicit }, { name: 'daily', ...explicit }] })
  assert.throws(() => loadRepoConfig(f.root, {}), /duplicate name/)
  for (const cmd of ['build', 'pack', 'test', 'l4', 'l5', 'ci']) assert.equal(await main([cmd, '--dsh-cli', entry]), 1)
  assert.equal(await main(['web', '--', '--profile', 'daily']), 1)
}))

it('CFG-03 preview has no writes, migration preserves preferences/YAML, repeat is no-op', () => environmentCase('CFG-03', f => {
  const old = f.legacy(); const before = snapshot(f.root); const bytes = readFileSync(f.paths.local); const yaml = readFileSync(f.paths.patch)
  assert.match(migrateConfig(f.root, true), /preview/)
  assert.deepEqual(snapshot(f.root), before)
  assert.match(migrateConfig(f.root), /committed/)
  const next = loadRepoConfig(f.root, {}).config
  assert.deepEqual(next.web, resolveConfig({ ...f.config, web: old.web }, f.root, f.paths.schema, {}).config.web)
  assert.deepEqual(next.test, old.test)
  assert.deepEqual(next.targets, []); assert.equal(next.legacy.dshCli, old.tools.dshCli)
  assert.deepEqual(readFileSync(f.paths.patch), yaml)
  const after = snapshot(f.root); assert.match(migrateConfig(f.root), /no-op/); assert.deepEqual(snapshot(f.root), after)
  const backup = Object.keys(after).find(key => key.includes('.local-backups') && key.endsWith('/local.json'))!
  assert.equal(after[backup], digest(bytes))
}))

it('CFG-04 failure injection preserves bytes, rollback failure blocks consumers', () => environmentCase('CFG-04', async f => {
  for (const point of ['backup', 'candidate', 'replace', 'verify'] as TransactionPoint[]) {
    for (const failIndex of [0, 1]) {
      f.legacy(); const before = readFileSync(f.paths.local)
      assert.throws(() => migrateConfig(f.root, false, { at: (stage, index) => { if (stage === point && index === failIndex) throw Object.assign(new Error('injected file busy/permission error'), { code: 'EPERM' }) } }))
      assert.deepEqual(readFileSync(f.paths.local), before)
      assert.equal(existsSync(maintenancePaths(f.root).pending), false)
      assert.equal(existsSync(maintenancePaths(f.root).state), false)
    }
  }
  if (process.platform === 'win32') {
    f.legacy()
    const plan = planMigration(f.root)!
    const before = readFileSync(f.paths.local)
    const ready = join(f.root, 'file-locked')
    const script = join(f.root, 'hold-file.ps1')
    writeFileSync(script, 'param([string]$Target,[string]$Ready)\n$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)\ntry { [System.IO.File]::WriteAllText($Ready, "ready"); Start-Sleep -Seconds 60 } finally { $stream.Dispose() }\n')
    const holder = startToFiles('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, f.paths.local, ready], { stdoutPath: join(f.root, 'lock.out'), stderrPath: join(f.root, 'lock.err') })
    try {
      for (let i = 0; !existsSync(ready) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(existsSync(ready))
      assert.throws(() => commitConfig(f.root, plan), /EPERM|EACCES|EBUSY/)
      assert.deepEqual(readFileSync(f.paths.local), before)
      assert.equal(existsSync(maintenancePaths(f.root).pending), false)
    } finally { await stopChild(holder.child) }
  }
  f.legacy()
  assert.throws(() => migrateConfig(f.root, false, { at: (stage, index) => { if ((stage === 'verify' && index === 0) || stage === 'rollback') throw new Error('file occupied') } }), /manual recovery/)
  assert.ok(existsSync(maintenancePaths(f.root).pending))
  assert.throws(() => loadRepoConfig(f.root, {}), /pending/)
  assert.throws(() => initializeConfig({}, f.root, {}), /pending/)
  assert.throws(() => migrateConfig(f.root, true), /pending/)
}))

it('CFG-05 stale plans, concurrent writers, process interruption and hash recovery', () => environmentCase('CFG-05', async f => {
  f.legacy(); const stale = planMigration(f.root)!; writeFileSync(f.paths.local, 'third-party edit')
  assert.throws(() => commitConfig(f.root, stale), /input changed/)
  assert.equal(readFileSync(f.paths.local, 'utf8'), 'third-party edit')
  f.legacy()
  assert.throws(() => migrateConfig(f.root, false, { at: stage => { if (stage === 'candidate') writeFileSync(f.paths.local, 'concurrent editor') } }), /input changed/)
  assert.equal(readFileSync(f.paths.local, 'utf8'), 'concurrent editor')
  f.legacy()
  const migrationUrl = pathToFileURL(join(sourceRoot, 'scripts/.build/core/config-migration.js')).href
  const childCode = `import {migrateConfig} from ${JSON.stringify(migrationUrl)};import {writeFileSync} from 'node:fs';migrateConfig(process.argv[1],false,{at(stage,index){if(stage==='verify'&&index===0){writeFileSync(process.argv[2],'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`
  const ready = join(f.root, 'ready')
  const child = startToFiles(process.execPath, ['--input-type=module', '-e', childCode, f.root, ready], { stdoutPath: join(f.root, 'child.out'), stderrPath: join(f.root, 'child.err') })
  try {
    for (let i = 0; !existsSync(ready) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(existsSync(ready), readFileSync(join(f.root, 'child.err'), 'utf8'))
    const contender = runToFiles(process.execPath, ['--input-type=module', '-e', `import {migrateConfig} from ${JSON.stringify(migrationUrl)};migrateConfig(process.argv[1]);`, f.root], { stdoutPath: join(f.root, 'contender.out'), stderrPath: join(f.root, 'contender.err') })
    assert.notEqual(contender.status, 0); assert.match(contender.stderr, /pending\/locked/)
  } finally { await stopChild(child.child) }
  assert.throws(() => loadRepoConfig(f.root, {}), /pending/)
  const paths = maintenancePaths(f.root)
  const pending = JSON.parse(readFileSync(paths.pending, 'utf8'))
  const backup = join(f.root, pending.backup)
  for (const file of pending.manifest.files) {
    const target = join(paths.directory, file.name)
    if (file.before === null) { if (existsSync(target)) { assert.equal(digest(readFileSync(target)), file.after); rmSync(target) } }
    else { assert.ok([file.before, file.after].includes(digest(readFileSync(target)))); const bytes = readFileSync(join(backup, file.name)); assert.equal(digest(bytes), file.before); writeFileSync(target, bytes) }
  }
  for (const path of pending.candidates) rmSync(join(f.root, path), { force: true })
  pending.manifest.status = 'rolled-back'; writeFileSync(join(backup, 'manifest.json'), JSON.stringify(pending.manifest))
  rmSync(paths.pending); rmSync(paths.lock)
  assert.match(migrateConfig(f.root), /committed/)
  rmSync(paths.state)
  f.legacy()
  assert.throws(() => migrateConfig(f.root, false, { at: (stage, index) => {
    if (stage === 'verify' && index === 0) writeFileSync(f.paths.local, 'third-party content after replacement')
  } }), /manual recovery/)
  assert.equal(readFileSync(f.paths.local, 'utf8'), 'third-party content after replacement')
  assert.throws(() => loadCommandContext({}, f.root, {}, 'target'), /pending/)
}))

it('CFG-06 missing tools, linked migration paths and independent cwd', () => environmentCase('CFG-06', f => {
  assert.throws(() => safeConfigPath(f.root, join(f.root, '..', 'outside')), /escapes/)
  if (process.platform === 'win32') assert.throws(() => safeConfigPath(f.root, 'Z:\\outside'), /escapes/)
  f.write()
  assert.throws(() => configuredDsh(loadCommandContext({}, f.root, {}), true), /M2/)
  assert.throws(() => configuredPnpm(loadCommandContext({}, f.root, {})), /pnpmScript/)
  f.legacy(); assert.match(migrateConfig(f.root, true), /preview/)
  const paths = maintenancePaths(f.root)
  symlinkSync(f.personal, paths.backups, process.platform === 'win32' ? 'junction' : 'dir')
  const before = snapshot(f.root)
  assert.throws(() => migrateConfig(f.root), /link/)
  assert.deepEqual(snapshot(f.root), before)
  rmSync(paths.backups)
  const migrationUrl = pathToFileURL(join(sourceRoot, 'scripts/.build/core/config-migration.js')).href
  const result = runToFiles(process.execPath, ['--input-type=module', '-e', `import {migrateConfig} from ${JSON.stringify(migrationUrl)};console.log(migrateConfig(process.argv[1]));`, f.root], { cwd: f.personal, env: { ...process.env, DSH_CLI: 'missing', DSH_PNPM: 'missing' }, stdoutPath: join(f.root, 'cwd.out'), stderrPath: join(f.root, 'cwd.err') })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(loadRepoConfig(f.root, {}).config.web.browserPath, join(f.root, 'custom browser'))
  // Bootstrap in an unprepared checkout diagnoses workspace installation before configuration.
  const scripts = join(f.root, 'scripts')
  writeFileSync(join(scripts, 'bootstrap.mjs'), readFileSync(join(sourceRoot, 'scripts/bootstrap.mjs')))
  const missing = runToFiles(process.execPath, [join(scripts, 'bootstrap.mjs'), 'test-env', '--suite', 'fast'], { cwd: f.personal, stdoutPath: join(f.root, 'missing.out'), stderrPath: join(f.root, 'missing.err') })
  assert.equal(missing.status, 1); assert.match(missing.stderr, /pnpm install/)
}))
