import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { selectL4Plugins } from '../../../scripts/.build/commands/l4.js'
import { isTargetCompatible } from '../../../scripts/.build/core/targets.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

function manifest(root: string, id: string, platforms: string[], surfaces = ['web']): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@fixture/${id}`, version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' }, targets: { platforms, surfaces } },
  }))
}

describe('L1 L4 non-manifest plugin selection', () => {
  it('keeps approval smoke coverage on mac and selects notify-web on Windows', () => {
    const mac = selectL4Plugins(repoRoot, { surface: 'web', platform: 'mac' })
    assert.deepEqual(mac.links.map(plugin => plugin.dirName), ['approval-allowlist', 'notify-web'])
    assert.equal(mac.tarball.packageName, '@mbda9091/approval-allowlist')
    const windows = selectL4Plugins(repoRoot, { surface: 'web', platform: 'windows' })
    assert.deepEqual(windows.links.map(plugin => plugin.dirName), ['notify-web'])
    assert.equal(windows.tarball.packageName, '@mbda9091/notify-web')
    for (const platform of ['mac', 'windows'] as const) {
      const target = { surface: 'web' as const, platform }
      const selection = selectL4Plugins(repoRoot, target)
      assert.ok(selection.links.every(plugin => isTargetCompatible(plugin, target)))
      assert.ok(isTargetCompatible(selection.tarball, target))
    }
  })

  it('follows discovered targets and package identity rather than hardcoded approval platforms', () => {
    const root = makeTempDir('l4-target-selection')
    try {
      manifest(root, 'approval-allowlist', ['windows'])
      manifest(root, 'notify-web', ['mac', 'windows'])
      const windows = selectL4Plugins(root, { surface: 'web', platform: 'windows' })
      assert.equal(windows.tarball.packageName, '@fixture/approval-allowlist')
      assert.equal(windows.tarball.dir, join(root, 'approval-allowlist'))
      assert.equal(selectL4Plugins(root, { surface: 'web', platform: 'mac' }).tarball.packageName, '@fixture/notify-web')
      manifest(root, 'approval-allowlist', ['windows'], ['desktop'])
      assert.deepEqual(selectL4Plugins(root, { surface: 'web', platform: 'windows' }).links.map(plugin => plugin.dirName), ['notify-web'])
    } finally { removeDir(root) }
  })

  it('fails explicitly when the notify-web SSE smoke target is unsupported', () => {
    const root = makeTempDir('l4-notify-target')
    try {
      manifest(root, 'approval-allowlist', ['mac'])
      manifest(root, 'notify-web', ['mac'])
      assert.throws(() => selectL4Plugins(root, { surface: 'web', platform: 'windows' }), /requires notify-web support for web\/windows/)
    } finally { removeDir(root) }
  })
})
