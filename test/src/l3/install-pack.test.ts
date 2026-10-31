import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import { runInstall } from '../../../scripts/.build/commands/install.js'
import { runPack } from '../../../scripts/.build/commands/pack.js'
import { configFixture, developmentPatch } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

function fixture(failure = '') {
  const f = configFixture()
  initializeConfig(f.options, f.root, f.env)
  developmentPatch(f)
  for (const [name, surfaces] of [['alpha', ['web']], ['beta', ['web']], ['desktop-only', ['desktop']]] as const) {
    mkdirSync(join(f.root, name, 'lib'), { recursive: true })
    writeFileSync(join(f.root, name, 'lib/index.js'), '')
    writeFileSync(join(f.root, name, 'package.json'), JSON.stringify({ name: `@local/${name}`, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' }, targets: { surfaces, platforms: ['windows', 'mac'] } } }))
  }
  const trace = join(f.root, 'trace.jsonl')
  const recorder = `const fs = require('node:fs'); const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_TRACE, JSON.stringify({tool: TOOL, args, cwd: process.cwd(), profile: process.env.DSH_PROFILE, directory: process.env.DSH_PROFILE_DIR}) + '\\n');`
  writeFileSync(f.entry, `#!/usr/bin/env node\nconst TOOL = 'dsh'; ${recorder}
    fs.mkdirSync(process.env.DSH_PROFILE_DIR, {recursive: true});
    if(process.env.TEST_FAILURE === 'add') process.exit(7);
    if(!args[4].endsWith('.tgz')) {
      const path=require('node:path'), pkg=JSON.parse(fs.readFileSync(path.join(args[4],'package.json')));
      const file=path.join(process.env.DSH_PROFILE_DIR,'package.json');
      const manifest=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{dependencies:{}};
      manifest.dependencies[pkg.name]='link:'+args[4];fs.writeFileSync(file,JSON.stringify(manifest));
      const link=path.join(process.env.DSH_PROFILE_DIR,'node_modules',pkg.name);
      fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(args[4],link,process.platform==='win32'?'junction':'dir');
    }`)
  writeFileSync(f.options.pnpmScript, `const TOOL = 'pnpm'; ${recorder}
    process.exit(process.env.TEST_FAILURE === args[0] ? 9 : 0);`)
  // A session-specific profile directory must not leak into another target.
  const context = loadCommandContext({}, f.root, { ...f.env, TEST_TRACE: trace, TEST_FAILURE: failure, DSH_PROFILE: 'personal', DSH_PROFILE_DIR: join(f.root, 'personal') }, 'development')
  const options = { mode: 'link' as const, profile: 'web', platform: 'windows', dryRun: false, skipBuild: true, all: false }
  const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { tool: string; args: string[]; cwd: string; directory: string; profile: string }) : []
  return { ...f, context, options, calls }
}

it('L3 install: dry-run filters targets, supports --all, and creates no profiles or scratch directories', async () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'alpha/lib'), { recursive: true })
    assert.equal(await runInstall({ ...f.options, skipBuild: false, dryRun: true }, f.context), 0)
    assert.equal(await runInstall({ ...f.options, dryRun: true, all: true }, f.context), 0)
    assert.deepEqual(f.calls(), [])
    assert.equal(existsSync(join(f.root, '.tmp')), false)
    assert.equal(existsSync(f.env.DSH_HOME!), false)
  } finally { removeDir(f.root) }
})

for (const mode of ['link'] as const) {
  it(`L3 install: ${mode} runs add then update, preserves quoted paths, and targets an isolated profile`, async () => {
    const f = fixture()
    try {
      mkdirSync(join(f.root, 'dist'))
      for (const name of ['alpha', 'beta']) writeFileSync(join(f.root, `dist/local-${name}-1.0.0.tgz`), '')
      const context = f.context
      assert.equal(await runInstall({ ...f.options, mode }, context), 0)
      const calls = f.calls()
      assert.deepEqual(calls.map(c => c.tool), ['dsh', 'pnpm', 'dsh', 'pnpm'])
      assert.deepEqual(calls[0]?.args, ['plugin', '--profile', 'web', 'add', mode === 'link' ? join(f.root, 'alpha') : join(f.root, 'dist/local-alpha-1.0.0.tgz')])
      assert.deepEqual(calls[1]?.args, ['update', '@local/alpha'])
      for (const call of calls) {
        assert.equal(call.profile, 'web')
        assert.equal(call.directory, join(mode === 'link' ? join(f.root, '.local/dsh-dev/home') : join(f.root, 'chosen-home'), 'profiles/web'))
        assert.ok(!call.args.includes('remove'))
      }
      assert.equal(calls[1]?.cwd, calls[1]?.directory)
      assert.equal(existsSync(join(f.root, 'personal')), false)
    } finally { removeDir(f.root) }
  })
}

it('L3 install/pack: preflight checks all artifacts before invoking tools', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'dist'))
    writeFileSync(join(f.root, 'dist/local-alpha-1.0.0.tgz'), '')
    const targetContext = loadCommandContext({ dshCli: f.cli, home: 'chosen-home', profile: 'web', surface: 'web', platform: 'windows' }, f.root, f.context.env, 'target')
    await assert.rejects(runInstall({ ...f.options, mode: 'tarball' }, targetContext), /requires.*--manifest/)
    rmSync(join(f.root, 'beta/lib'), { recursive: true })
    await assert.rejects(runInstall(f.options, f.context), /no build output.*beta/)
    await assert.rejects(runPack({ skipBuild: true }, f.context), /no build output.*beta/)
    assert.deepEqual(f.calls(), [])
  } finally { removeDir(f.root) }
})

for (const [failure, code, tools] of [['add', 7, ['dsh']], ['update', 9, ['dsh', 'pnpm']]] as const) {
  it(`L3 install: ${failure} failure stops before the next package and propagates its code`, async () => {
    const f = fixture(failure)
    try {
      assert.equal(await runInstall(f.options, f.context), code)
      assert.deepEqual(f.calls().map(c => c.tool), tools)
    } finally { removeDir(f.root) }
  })
}

it('L3 pack: uses configured pnpm, requires actual archives even on exit zero, and stops on failure', async () => {
  for (const failure of ['', 'pack']) {
    const f = fixture(failure)
    try {
      if (failure) assert.equal(await runPack({ skipBuild: true }, f.context), 9)
      else await assert.rejects(runPack({ skipBuild: true }, f.context), /ENOENT/)
      assert.equal(f.calls().length, 1)
      assert.deepEqual(f.calls()[0]?.args.slice(0, 2), ['pack', '--pack-destination'])
      assert.ok(f.calls()[0]?.args[2]?.startsWith(join(f.root, 'dist/batches')))
      assert.equal(f.calls()[0]?.cwd, join(f.root, 'alpha'))
    } finally { removeDir(f.root) }
  }
})
