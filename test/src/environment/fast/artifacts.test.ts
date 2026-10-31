import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { environmentCase, environmentTest as it } from '../../harness/environment.js'
import { artifactFixture, packageFixture, tarball, verificationFixture } from '../../harness/artifacts.js'
import { readPackage, checkPackedSource } from '../../../../scripts/.build/core/artifact-package.js'
import { artifactLock, assertConsumed, copyArtifact, loadArtifacts } from '../../../../scripts/.build/core/artifacts.js'
import { readVerification, validateVerification, verificationPath } from '../../../../scripts/.build/core/artifact-verification.js'
import { resolveTarget } from '../../../../scripts/.build/core/targets.js'

it('ART-02 malformed archives metadata missing files contamination and same-version replacement fail preflight', () => environmentCase('ART-02', f => {
  for (const mutate of [
    (files: Record<string, string>) => { delete files['lib/index.js'] },
    (files: Record<string, string>) => { files['scripts/config/local.json'] = '{}' },
    (files: Record<string, string>) => { files['node_modules/@deepseek-ai/dsh/package.json'] = '{}' },
    (files: Record<string, string>) => { const m = JSON.parse(files['package.json']!); m.dsh.targets.surfaces = ['linux']; files['package.json'] = JSON.stringify(m) },
    (files: Record<string, string>) => { const m = JSON.parse(files['package.json']!); m.dependencies = { '@deepseek-ai/dsh': '*' }; files['package.json'] = JSON.stringify(m) },
    (files: Record<string, string>) => { files['../escape'] = 'bad' },
  ]) { const { files } = packageFixture(); mutate(files); assert.throws(() => readPackage(tarball(files))) }
  const complete = packageFixture(), source = join(f.root, 'alpha')
  for (const [path, text] of Object.entries(complete.files)) { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), text) }
  const content = readPackage(tarball(complete.files)); checkPackedSource(source, content)
  writeFileSync(join(source, 'lib/required-at-runtime.json'), '{}')
  assert.throws(() => checkPackedSource(source, content), /missing or changed runtime resource/)
  const set = artifactFixture(f.root), { files } = packageFixture()
  files['lib/index.js'] += '\n// same name/version, different bytes'
  writeFileSync(join(dirname(set.path), set.manifest.packages[0]!.path), tarball(files))
  assert.throws(() => loadArtifacts(f.root, set.path), /hash changed/)
  assert.equal(existsSync(join(f.root, '.local')), false)
}))

it('ART-03 stale batches dirty source missing corrupt future and exit-only evidence are rejected', () => environmentCase('ART-03', f => {
  const set = artifactFixture(f.root), good = verificationFixture(set), target = resolveTarget({ surface: 'web' })
  const check = (v: unknown) => validateVerification(set, v, target, '0.2.1-rc.2', ['@local/alpha'])
  check(good)
  for (const invalid of [null, { exitCode: 0 }, { ...good, version: 2 }, { ...good, contracts: [] }, { ...good, environment: [] },
    { ...good, functions: { l4: { ...good.functions.l4, steps: [] } } }, { ...good, coverage: [] }, { ...good, status: 'failed' }]) assert.throws(() => check(invalid))
  assert.throws(() => readVerification(set, target, '0.2.1-rc.2', ['@local/alpha']), /ENOENT/)
  const path = verificationPath(set, target.platform); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{broken')
  assert.throws(() => readVerification(set, target, '0.2.1-rc.2', ['@local/alpha']))
  writeFileSync(join(f.root, 'uncommitted.ts'), '// changed')
  assert.throws(() => check(good), /source state changed/)
  rmSync(join(f.root, 'uncommitted.ts')); artifactFixture(f.root)
  assert.throws(() => check(good), /superseded/)
  const rebuilt = artifactFixture(f.root)
  writeFileSync(join(f.root, 'dist/build-generation'), 'new-build')
  assert.throws(() => loadArtifacts(f.root, rebuilt.path), /rebuilt/)
}))

it('ART-04 Web evidence cannot cover desktop other platform or another host version', () => environmentCase('ART-04', f => {
  const set = artifactFixture(f.root), good = verificationFixture(set), target = resolveTarget({ surface: 'web' })
  for (const [scope, host] of [[{ ...target, surface: 'desktop' as const }, '0.2.1-rc.2'], [{ ...target, platform: target.platform === 'windows' ? 'mac' as const : 'windows' as const }, '0.2.1-rc.2'], [target, '0.2.2']] as const) {
    assert.throws(() => validateVerification(set, good, scope, host, ['@local/alpha']), /incompatible|uncovered/)
  }
}))

it('ART-05 durable records survive tmp cleanup and consumption detects replacement; pack lock excludes competitors', () => environmentCase('ART-05', f => {
  const set = artifactFixture(f.root), good = verificationFixture(set), target = resolveTarget({ surface: 'web' })
  const path = verificationPath(set, target.platform); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(good))
  rmSync(join(f.root, '.tmp'), { recursive: true })
  readVerification(set, target, '0.2.1-rc.2', ['@local/alpha'])
  const release = artifactLock(f.root)
  try { assert.throws(() => artifactLock(f.root), /locked/) } finally { release() }
  const p = set.manifest.packages[0]!, input = copyArtifact(set, p, join(f.root, '.tmp/input.tgz'))
  assertConsumed(set, p, input); writeFileSync(input, 'replaced')
  assert.throws(() => assertConsumed(set, p, input), /changed during consumption/)
  const archive = join(dirname(set.path), p.path), original = readFileSync(archive)
  writeFileSync(input, original); writeFileSync(archive, 'replaced')
  assert.throws(() => assertConsumed(set, p, input), /hash changed/)
}))
