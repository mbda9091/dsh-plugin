import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { environmentCase, environmentTest as it, sourceRoot } from '../../harness/environment.js'
import type { fixture } from '../../harness/environment.js'
import { prepareIsolation } from '../../harness/isolation.js'
import { runBuild } from '../../../../scripts/.build/commands/build.js'
import { runPack } from '../../../../scripts/.build/commands/pack.js'
import { runL4 } from '../../../../scripts/.build/commands/l4.js'
import { runVerifyArtifacts } from '../../../../scripts/.build/commands/verify-artifacts.js'
import { loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { loadArtifacts } from '../../../../scripts/.build/core/artifacts.js'
import { readVerification, validateVerification, verificationPath, validateArtifactReport } from '../../../../scripts/.build/core/artifact-verification.js'
import { resolveTarget } from '../../../../scripts/.build/core/targets.js'
import type { TestReport } from '../../../../scripts/.build/core/test-run.js'
import { artifactPrerequisites, installArtifacts, checkArtifactInstallations } from '../../../../scripts/.build/core/artifact-harness.js'
import { runIsolatedTest } from '../../../../scripts/.build/core/test-run.js'
import { initProfile } from '../../../../scripts/.build/core/web-harness.js'

let built: Promise<number> | undefined
async function prepare(f: ReturnType<typeof fixture>) {
  prepareIsolation(f, true)
  const config = JSON.parse(readFileSync(join(sourceRoot, 'scripts/config/example.json'), 'utf8'))
  config.tools.pnpmScript = process.env.DSH_ENV_TEST_PNPM
  built ??= runBuild({ check: false }, { root: sourceRoot, config, env: { ...process.env }, purpose: 'test' })
  assert.equal(await built, 0)
  for (const path of ['package.json', 'lib', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md']) cpSync(join(sourceRoot, 'notify-web', path), join(f.root, 'notify-web', path), { recursive: true })
  f.config.test.browser = process.env.DSH_ENV_TEST_BROWSER || process.env.DSH_E2E_BROWSER || 'chrome'
  f.config.test.browserPath = process.env.DSH_ENV_TEST_BROWSER_PATH || process.env.CHROME_PATH || null
  f.config.test.timeoutMs = 120_000; f.write()
  const settings = loadCommandContext({}, f.root, { ...process.env, DSH_PNPM: process.env.DSH_ENV_TEST_PNPM }, 'test')
  let manifest = ''
  assert.equal(await runPack({ skipBuild: true }, settings, path => { manifest = path }), 0)
  return { settings, manifest, set: loadArtifacts(f.root, manifest) }
}

it('ART-01 fixed real tarball installs identical bytes with no source lib fallback or repack', { timeout: 240_000 }, () => environmentCase('ART-01', async f => {
  const { settings, set } = await prepare(f), started = new Date().toISOString()
  rmSync(join(f.root, 'notify-web/lib'), { recursive: true })
  let report: TestReport | undefined
  assert.equal(await runL4({ keep: false, skipTarball: false, artifacts: set }, settings, r => { report = r }), 0)
  validateArtifactReport(report, 'l4', set, started)
  assert.equal(existsSync(join(f.root, 'notify-web/lib')), false)
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'ART-01-details.json'), JSON.stringify({ manifest: set.manifest, report }, null, 2))
}, false))

it('ART-02-real replaced same-version bytes fail before any profile creation', { timeout: 120_000 }, () => environmentCase('ART-02-real', async f => {
  const { settings, set, manifest } = await prepare(f), item = set.manifest.packages[0]!
  writeFileSync(join(dirname(manifest), item.path), 'replacement')
  await assert.rejects(runVerifyArtifacts({ manifest, keep: false }, settings), /hash changed/)
  assert.equal(existsSync(join(f.root, '.tmp/l4')), false)
  assert.equal(existsSync(join(f.root, '.tmp/l5')), false)
}, false))

it('ART-04-real real Web acceptance explicitly refuses desktop other platform and untested host', { timeout: 360_000 }, () => environmentCase('ART-04-real', async f => {
  const { settings, set, manifest } = await prepare(f)
  assert.equal(await runVerifyArtifacts({ manifest, keep: false }, settings), 0)
  const target = resolveTarget({ surface: 'web' }), record = readVerification(set, target, '0.2.1-rc.2', ['@local/notify-web'])
  for (const [scope, host] of [[{ ...target, surface: 'desktop' as const }, '0.2.1-rc.2'], [{ ...target, platform: target.platform === 'windows' ? 'mac' as const : 'windows' as const }, '0.2.1-rc.2'], [target, '0.2.2']] as const) assert.throws(() => validateVerification(set, record, scope, host, ['@local/notify-web']))
}, false))

it('ART-05-real competing packs serialize unique batches and replacement during real consumption fails', { timeout: 240_000 }, () => environmentCase('ART-05-real', async f => {
  const { settings } = await prepare(f)
  let manifest = ''
  const results = await Promise.allSettled([runPack({ skipBuild: true }, settings, path => { manifest = path }), runPack({ skipBuild: true }, settings)])
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected')
  const set = loadArtifacts(f.root, manifest), item = set.manifest.packages[0]!
  const code = await runIsolatedTest('art-mutation', settings, { keep: false, timeoutMs: 120000 }, async c => {
    await c.step('contracts', async () => artifactPrerequisites(c, set))
    await c.step('profile', () => initProfile(c, 'init', c.home))
    await c.step('install', () => installArtifacts(c, set))
    await c.step('mutation', async () => {
      // Mutate after the actual consumer read, before its final content check.
      writeFileSync(join(c.runDir, 'inputs', item.path), 'changed during consumption')
      checkArtifactInstallations(c, set); return 'must not pass'
    })
  })
  assert.equal(code, 1)
  const report = JSON.parse(readFileSync(join(f.root, '.tmp/art-mutation/last-report.json'), 'utf8'))
  assert.equal(report.steps.at(-1).name, 'mutation'); assert.equal(report.steps.at(-1).ok, false)
  assert.match(report.steps.at(-1).detail, /changed during consumption/)
}, false))

it('ART-06 actual notify-web package contracts L4 L5 and durable evidence share the same hashes', { timeout: 360_000 }, () => environmentCase('ART-06', async f => {
  const { settings, set, manifest } = await prepare(f)
  assert.equal(await runVerifyArtifacts({ manifest, keep: false }, settings), 0)
  const target = resolveTarget({ surface: 'web' }), path = verificationPath(set, target.platform)
  const record = readVerification(set, target, '0.2.1-rc.2', ['@local/notify-web'])
  assert.equal(record.functions.l4?.ok, true); assert.equal(record.functions.l5?.ok, true)
  assert.equal(record.environment.length, 2)
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'ART-06-details.json'), JSON.stringify({ manifest: set.manifest, record }, null, 2))
  rmSync(join(f.root, '.tmp'), { recursive: true })
  assert.ok(existsSync(path)); readVerification(set, target, '0.2.1-rc.2', ['@local/notify-web'])
}, false))
