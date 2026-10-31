import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beginBuild, completeBuild, assertCurrentBuild } from '../../../scripts/.build/core/build-record.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'

it('L3 build provenance: missing, stale source, edited output and failed builds cannot be packed as current', () => {
  const root = makeTempDir('build-record')
  try {
    mkdirSync(join(root, 'alpha/lib'), { recursive: true })
    writeFileSync(join(root, 'alpha/package.json'), JSON.stringify({ name: '@local/alpha', dsh: { bundle: {} } }))
    const src = join(root, 'alpha/source.ts'), out = join(root, 'alpha/lib/index.js')
    writeFileSync(src, 'original'); writeFileSync(out, 'compiled')
    assert.throws(() => assertCurrentBuild(root), /missing successful build/)
    completeBuild(root, beginBuild(root)); assertCurrentBuild(root)
    writeFileSync(src, 'changed'); assert.throws(() => assertCurrentBuild(root), /stale build/)
    writeFileSync(src, 'original'); assertCurrentBuild(root)
    writeFileSync(out, 'modified output'); assert.throws(() => assertCurrentBuild(root), /stale build/)
    writeFileSync(out, 'compiled'); assertCurrentBuild(root)
    beginBuild(root); assert.throws(() => assertCurrentBuild(root), /stale build/)
    const start = beginBuild(root); writeFileSync(src, 'edit during compilation')
    assert.throws(() => completeBuild(root, start), /source changed during build/)
  } finally { removeDir(root) }
})
