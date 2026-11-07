import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, copyFileSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { environmentCase, environmentTest as it, snapshot, sourceRoot } from '../../harness/environment.js'
import { loadCommandContext, configuredDsh } from '../../../../scripts/.build/core/command-context.js'
import { installHome, nodeDsh } from '../../../../scripts/.build/core/install-target.js'
import { main as dev } from '../../../../scripts/.build/dev-cli.js'
import { main as install } from '../../../../scripts/.build/install-cli.js'
import { assertFileOnlyProbe } from '../../harness/file-only-probe.js'

it('CFG-01 defaults require no local JSON and ignore broken legacy files and maintenance state', () => environmentCase('CFG-01', f => {
  f.fake()
  const empty = loadCommandContext({}, f.root, {})
  assert.equal(empty.config.test.timeoutMs, 120000)
  writeFileSync(f.paths.local, '{ broken secret input')
  for (const name of ['.local-maintenance.lock', '.local-maintenance.pending.json']) writeFileSync(join(f.root, 'scripts/config', name), 'legacy')
  const before = snapshot(f.root)
  assert.deepEqual(loadCommandContext({}, f.root, {}).config, empty.config)
  assert.equal(configuredDsh(empty, true).source.length > 0, true)
  assert.deepEqual(snapshot(f.root), before)
}))
it('CFG-02 development strips external destination and accepts only relevant settings', () => environmentCase('CFG-02', f => {
  const env = { DSH_HOME: f.personal, DSH_PROFILE: 'daily', DSH_PROFILE_DIR: f.personal, DSH_CLI: 'private', CHROME_PATH: 'private' }
  const before = { ...env }
  const c = loadCommandContext({}, f.root, env, 'development')
  assert.equal(c.env.DSH_HOME, join(f.root, '.local/dsh-dev/home'))
  assert.equal(c.env.DSH_CLI, undefined)
  assert.equal(c.config.test.browserPath, null)
  assert.throws(() => loadCommandContext({ profile: 'daily' }, f.root, env), /not supported/)
  assert.deepEqual(env, before)
}))
it('CFG-03 home follows explicit environment default and tilde rules; profile remains mandatory', () => environmentCase('CFG-03', f => {
  assert.equal(installHome(undefined, {}, f.personal), join(f.personal, '.dsh'))
  assert.equal(installHome(undefined, { DSH_HOME: '  ' }, f.personal), join(f.personal, '.dsh'))
  assert.equal(installHome(undefined, { DSH_HOME: '~/custom' }, f.personal), join(f.personal, 'custom'))
  assert.equal(installHome('~\\chosen', { DSH_HOME: 'ignored' }, f.personal), join(f.personal, 'chosen'))
  assert.throws(() => loadCommandContext({}, f.root, { DSH_PROFILE: 'web' }, 'target'), /--profile is required/)
  const c = loadCommandContext({ profile: 'custom', dshCli: join(f.root, 'external.cjs') }, f.root, { DSH_HOME: f.personal, DSH_PROFILE_DIR: 'ignored' }, 'target')
  assert.equal(c.target!.home, f.personal)
  assert.equal(c.target!.surface, 'web')
  assert.equal(c.env.DSH_PROFILE_DIR, join(f.personal, 'profiles/custom'))
  assert.throws(() => loadCommandContext({ profile: 'web', target: 'old' }, f.root, {}, 'target'), /removed/)
  assert.throws(() => loadCommandContext({ profile: 'web', platform: 'linux' }, f.root, {}, 'target'), /platform/)
}))
it('CFG-04 entrypoints reject cross-purpose and retired options without side effects', () => environmentCase('CFG-04', async f => {
  const before = snapshot(f.root)
  for (const args of [['install', '--profile', 'web'], ['status'], ['stable-install'], ['config', 'init'], ['target', 'bind']]) assert.equal(await dev(args), 1)
  for (const args of [['build'], ['ci'], ['install', '--surface', 'web'], ['install', '--target', 'old'], ['status', '--rebuild']]) assert.equal(await install(args), 1)
  assert.deepEqual(snapshot(f.root), before)
}))
it('CFG-05 Node DSH discovery is confined to the selected runtime; aliases and ambiguity fail', () => environmentCase('CFG-05', f => {
  const bin = join(f.root, 'runtime/bin'), entry = join(f.root, 'runtime/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  mkdirSync(bin, { recursive: true }); mkdirSync(dirname(entry), { recursive: true })
  const node = join(bin, 'node'); writeFileSync(node, 'fake selected node')
  writeFileSync(entry, '#!/usr/bin/env node\n')
  assert.equal(nodeDsh(f.root, { PATH: join(f.root, 'node_modules/.bin') }, node), entry)
  const duplicate = join(bin, 'node_modules/@deepseek-ai/dsh/lib/bin.js'); mkdirSync(dirname(duplicate), { recursive: true }); writeFileSync(duplicate, '#!/usr/bin/env node\n')
  assert.throws(() => nodeDsh(f.root, {}, node), /2 matching/)
  const local = f.fake(), otherBin = join(f.root, 'other/bin'); mkdirSync(otherBin, { recursive: true }); writeFileSync(join(otherBin, 'node'), 'fake')
  const alias = join(otherBin, 'node_modules/@deepseek-ai/dsh/lib'); mkdirSync(alias, { recursive: true }); symlinkSync(local, join(alias, 'bin.js'), 'file')
  assert.throws(() => nodeDsh(f.root, {}, join(otherBin, 'node')), /workspace development/)
  const npmBin = join(f.root, 'npm-node'), prefix = join(f.root, 'custom-global')
  mkdirSync(npmBin)
  const runtime = join(npmBin, process.platform === 'win32' ? 'node.exe' : 'node')
  copyFileSync(process.execPath, runtime, constants.COPYFILE_FICLONE)
  const npm = join(npmBin, 'node_modules/npm/bin/npm-cli.js')
  mkdirSync(dirname(npm), { recursive: true })
  writeFileSync(npm, `console.log(${JSON.stringify(prefix)})`)
  const globalDsh = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@deepseek-ai/dsh/lib/bin.js')
  mkdirSync(dirname(globalDsh), { recursive: true }); writeFileSync(globalDsh, '#!/usr/bin/env node\n')
  assert.equal(assertFileOnlyProbe(() => nodeDsh(f.root, {}, runtime)), globalDsh)
  writeFileSync(npm, 'console.log("relative-prefix")')
  assert.throws(() => nodeDsh(f.root, {}, runtime), /invalid npm global prefix/)
  writeFileSync(npm, 'process.exit(1)')
  assert.throws(() => assertFileOnlyProbe(() => nodeDsh(f.root, {}, runtime)), /cannot resolve current Node npm global prefix/)

}))
it('CFG-06 settings validate only supported inputs and flags override environment', () => environmentCase('CFG-06', f => {
  const c = loadCommandContext({ testBrowser: 'chromium', testTimeoutMs: 12 }, f.root, { DSH_E2E_BROWSER: 'chrome' }, 'test')
  assert.equal(c.config.test.browser, 'chromium'); assert.equal(c.config.test.timeoutMs, 12)
  for (const opts of [{ testBrowser: 'invalid' }, { testTimeoutMs: -1 }, { pnpmScript: '\n' }]) assert.throws(() => loadCommandContext(opts, f.root, {}, 'test'))
  assert.match(readFileSync(join(sourceRoot, 'scripts/bootstrap.mjs'), 'utf8'), /Combined entry removed/)
}))
