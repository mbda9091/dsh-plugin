import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environmentTest as it } from '../../harness/environment.js'
import { runWeb } from '../../../../scripts/.build/commands/web.js'
import { runInstall } from '../../../../scripts/.build/commands/install.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { developmentPaths, verifyDevelopmentLinks } from '../../../../scripts/.build/core/development.js'
import { developmentStatus, stopDevelopment } from '../../../../scripts/.build/core/development-process.js'
import { waitForExit, waitForHttpClosed } from '../../../../scripts/.build/core/exec.js'
import { inspectWebPatch } from '../../../../scripts/.build/core/web-patch.js'
import { environmentCase, sourceRoot, snapshot } from '../../harness/environment.js'
import { launchDevelopment, prepareDevelopment } from '../../harness/development.js'

it('DEV-03 real link, loaded revisions, restart/reset persistence (DEV-01/04/05 real)', { timeout: 240_000 }, () => environmentCase('DEV-03', async f => {
  const d = prepareDevelopment(f)
  const pnpm = process.env.DSH_ENV_TEST_PNPM
  assert.ok(pnpm, 'real suite requires --pnpm-script')
  // Share only the immutable locked host; every mutable directory belongs to this fixture.
  const dependency = join(f.root, 'node_modules/@deepseek-ai/dsh')
  rmSync(dependency, { recursive: true })
  symlinkSync(realpathSync(join(sourceRoot, 'node_modules/@deepseek-ai/dsh')), dependency, process.platform === 'win32' ? 'junction' : 'dir')
  f.config.tools.pnpmScript = pnpm; f.config.web.startupTimeoutMs = 60_000; f.write()
  const plugin = { packageName: '@local/m3-fixture', dir: join(f.root, 'm3-fixture') }
  mkdirSync(join(plugin.dir, 'lib'), { recursive: true })
  writeFileSync(join(plugin.dir, 'package.json'), JSON.stringify({ name: plugin.packageName, version: '1.0.0', type: 'module', exports: './lib/index.js', files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' }, targets: { surfaces: ['web'], platforms: ['windows', 'mac'] } } }))
  writeFileSync(join(plugin.dir, 'cordis.patch.yml'), '- insert:\n    - id: m3-fixture\n      name: "@local/m3-fixture"\n')
  writeFileSync(join(f.root, 'profiles/web/cordis.dev.patch.yml'), "- id: hmr\n  config:\n    root: ['${repoRoot}/m3-fixture/lib']\n")
  const p = developmentPaths(f.root), marker = join(p.home, 'loaded-revision')
  const revision = (n: number) => writeFileSync(join(plugin.dir, 'lib/index.js'), `import {writeFileSync} from 'node:fs'; export const name='m3-fixture'; export function apply(){writeFileSync(${JSON.stringify(marker)},${JSON.stringify(String(n))})}`)
  revision(1)
  const context = loadCommandContext({}, f.root, d.env, 'development')
  assert.equal(await runInstall({ mode: 'link', dryRun: false, skipBuild: true, all: false }, context), 0)
  verifyDevelopmentLinks(context, [plugin])
  assert.deepEqual(inspectWebPatch(p.patch, f.root).roots, [join(plugin.dir, 'lib')])
  const patch = readFileSync(p.patch)
  writeFileSync(join(p.home, 'debug-session'), 'keep me')
  await runWeb(['init'], f.root, d.env); assert.deepEqual(readFileSync(p.patch), patch)
  for (let i = 1; i <= 2; i++) {
    revision(i)
    const { started } = await launchDevelopment(f.root, d.env)
    let cleanUrl: string | undefined
    try {
      const runtime = JSON.parse(readFileSync(p.runtime, 'utf8')); cleanUrl = runtime.url
      assert.equal(readFileSync(marker, 'utf8'), String(i), 'fresh host must actually load changed link output')
      assert.equal(readFileSync(join(p.home, 'debug-session'), 'utf8'), 'keep me')
      await assert.rejects(runWeb(['--no-open', '--port', '0'], f.root, d.env), /already recorded/)
      assert.match(await developmentStatus(context), /running/)
    } finally { await stopDevelopment(context); await waitForExit(started.child, 10_000) }
    assert.ok(cleanUrl); await waitForHttpClosed(cleanUrl, 10_000)
  }
  const before = snapshot(plugin.dir)
  const { started } = await launchDevelopment(f.root, d.env)
  try { await runWeb(['reset', '--yes'], f.root, d.env) }
  finally { if (existsSync(p.runtime)) await stopDevelopment(context); await waitForExit(started.child, 10_000) }
  assert.equal(existsSync(p.directory), false)
  assert.deepEqual(snapshot(plugin.dir), before)
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'DEV-03-details.json'), JSON.stringify({ coverage: ['DEV-01 real', 'DEV-03', 'DEV-04 real duplicate', 'DEV-05 real'], host: '0.2.1-rc.2', revisionsLoaded: [1, 2], resetSourceUnchanged: true, personalSentinelsUnchanged: true }, null, 2))
}, false))
