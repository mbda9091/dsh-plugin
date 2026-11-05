import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFixture } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'
import { packageFixture, tarball } from '../harness/artifacts.js'
import { beginBuild, completeBuild, toolFingerprint } from '../../../scripts/.build/core/build-record.js'
import { newBatch, describeArtifact, publishManifest, sourceState } from '../../../scripts/.build/core/artifacts.js'
import { installCache } from '../../../scripts/.build/core/install-cache.js'
it('L3 install cache: reuse archive without lib, reuse build without archive, invalidate same-version changes and reject corruption', () => {
  const f = configFixture()
  try {
    const pkg = packageFixture(), dir = join(f.root, 'alpha')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkg.files['package.json']!)
    writeFileSync(join(dir, 'lib/index.js'), pkg.files['lib/index.js']!)
    writeFileSync(join(dir, 'source.ts'), 'original')
    assert.equal(installCache(f.root).mode, 'rebuild')
    completeBuild(f.root, beginBuild(f.root))
    assert.equal(installCache(f.root).mode, 'reuse-build')
    const { batch, directory } = newBatch(f.root), file = 'mbda9091-alpha-1.0.0.tgz'
    writeFileSync(join(directory, file), tarball(pkg.files))
    publishManifest(f.root, { version: 1, batch, createdAt: new Date().toISOString(), source: sourceState(f.root), fingerprint: toolFingerprint(f.root), tools: { node: process.version, pnpm: '11.28.5' }, packages: [describeArtifact(join(directory, file), file)] })
    assert.equal(installCache(f.root).mode, 'reuse-tarball')
    rmSync(join(dir, 'lib'), { recursive: true })
    assert.equal(installCache(f.root).mode, 'reuse-tarball')
    assert.equal(installCache(f.root, true).mode, 'rebuild')
    writeFileSync(join(dir, 'source.ts'), 'same version different code')
    assert.equal(installCache(f.root).mode, 'rebuild')
    writeFileSync(join(dir, 'source.ts'), 'original')
    writeFileSync(join(f.root, 'node_modules/esbuild/package.json'), '{"version":"2.0.0"}')
    assert.equal(installCache(f.root).mode, 'rebuild')
    writeFileSync(join(f.root, 'node_modules/esbuild/package.json'), '{"version":"1.0.0-fixture"}')
    writeFileSync(join(directory, file), 'corrupt')
    assert.throws(() => installCache(f.root), /hash changed/)
  } finally { removeDir(f.root) }
})
