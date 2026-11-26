import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beginBuild, completeBuild, assertCurrentBuild } from "../../../../scripts/.build/core/build-record.js"
import { makeTempDir, removeDir } from '../harness/tmp.js'

it('L3 build provenance: missing, stale source, edited output and failed builds cannot be packed as current', () => {
  const root = makeTempDir('build-record')
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5' }))
    for (const name of ['typescript', 'esbuild']) {
      mkdirSync(join(root, 'node_modules', name), { recursive: true })
      writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    }
    mkdirSync(join(root, 'plugins/alpha/lib'), { recursive: true })
    writeFileSync(join(root, 'plugins/alpha/package.json'), JSON.stringify({ name: '@mbda9091/alpha', dsh: { bundle: {} } }))
    const src = join(root, 'plugins/alpha/source.ts'), out = join(root, 'plugins/alpha/lib/index.js')
    writeFileSync(src, 'original'); writeFileSync(out, 'compiled')
    const shared = join(root, 'plugins/common/shared/lib/index.js')
    mkdirSync(join(root, 'plugins/common/shared/lib'), { recursive: true }); writeFileSync(shared, 'shared compiled')
    assert.throws(() => assertCurrentBuild(root), /missing successful build/)
    completeBuild(root, beginBuild(root)); assertCurrentBuild(root)
    writeFileSync(src, 'changed'); assert.throws(() => assertCurrentBuild(root), /stale build/)
    writeFileSync(src, 'original'); assertCurrentBuild(root)
    writeFileSync(out, 'modified output'); assert.throws(() => assertCurrentBuild(root), /stale build/)
    writeFileSync(out, 'compiled'); assertCurrentBuild(root)
    writeFileSync(shared, 'changed shared output'); assert.throws(() => assertCurrentBuild(root), /stale build/)
    writeFileSync(shared, 'shared compiled'); assertCurrentBuild(root)
    beginBuild(root); assert.throws(() => assertCurrentBuild(root), /stale build/)
    const start = beginBuild(root); writeFileSync(src, 'edit during compilation')
    assert.throws(() => completeBuild(root, start), /source changed during build/)
  } finally { removeDir(root) }
})
