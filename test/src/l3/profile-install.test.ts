import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '../harness/environment.js'
import { prepareTarget } from '../harness/targets.js'
import { artifactFixture, packageFixture } from '../harness/artifacts.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'
import { runDirectArtifactInstall } from '../../../scripts/.build/commands/install-artifacts.js'
import { runProfileInstall } from '../../../scripts/.build/commands/profile-install.js'
import { packageDefaults } from '../../../scripts/.build/core/profile-patch.js'
import { readPackage } from '../../../scripts/.build/core/artifact-package.js'
import { tarball } from '../harness/artifacts.js'

it('L3 direct install preflight: explicit Web existing profile, legacy packages and dry-run preserve target', async () => {
  const base = makeTempDir('direct-preflight'), f = fixture(base), target = prepareTarget(f)
  target.fields.home = join(base, 'home')
  const options = { rebuild: false, dryRun: true, only: '@mbda9091/alpha', archiveRoot: join(base, 'delivery/releases') }
  try {
    await assert.rejects(runProfileInstall(options, target.context()), /existing profile/)
    const directory = join(target.fields.home, 'profiles/web')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"dependencies":{}}')
    const pkg = packageFixture(), manifest = JSON.parse(pkg.files['package.json']!)
    manifest.dshPlugin = { profileDefaults: './profile.defaults.patch.yml' }
    const dir = join(f.root, 'alpha'); mkdirSync(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(dir, 'profile.defaults.patch.yml'), "- id: alpha\n  name: '@mbda9091/alpha'\n  config: {}\n")
    writeFileSync(target.cli, readFileSync(target.cli, 'utf8').replaceAll('0.2.1-rc.2', JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/dsh']))
    const before = readFileSync(join(directory, 'package.json'), 'utf8')
    assert.equal(await runProfileInstall(options, target.context()), 0)
    assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), before)
    assert.equal(existsSync(join(directory, 'mbda9091')), false)
    assert.equal(existsSync(join(directory, '.mbda9091-install.lock')), false)
    assert.equal(existsSync(target.trace), false)
    writeFileSync(join(directory, 'package.json'), '{"dependencies":{"@local/alpha":"link:old"}}')
    writeFileSync(join(directory, 'cordis.patch.yml'), "- id: alpha\n  name: '@local/alpha'\n")
    assert.equal(await runProfileInstall(options, target.context()), 0)
    assert.equal(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies['@local/alpha'], 'link:old')
    writeFileSync(target.mode, 'version')
    await assert.rejects(runProfileInstall(options, target.context()), /incompatible DSH version/)
    assert.equal(existsSync(target.trace), false)
    assert.equal(existsSync(join(directory, '.mbda9091-install.lock')), false)
    await assert.rejects(runProfileInstall({ ...options, dryRun: false }, target.context()), /incompatible DSH version/)
    assert.equal(existsSync(target.trace), false)
    const packed = packageFixture(), metadata = JSON.parse(packed.files['package.json']!)
    metadata.dshPlugin = { profileDefaults: './profile.defaults.patch.yml' }
    packed.files['package.json'] = JSON.stringify(metadata)
    packed.files['profile.defaults.patch.yml'] = "- id: alpha\n  name: '@mbda9091/alpha'\n  config: {}\n"
    const set = artifactFixture(f.root, tarball(packed.files))
    const direct = { mode: 'tarball' as const, manifest: set.path, all: false, skipBuild: false, dryRun: true }
    await assert.rejects(runDirectArtifactInstall(direct, target.context()), /incompatible DSH version/)
    writeFileSync(target.mode, '')
    assert.equal(await runDirectArtifactInstall(direct, target.context()), 0)
    assert.equal(existsSync(target.trace), false)
    assert.equal(existsSync(join(directory, 'mbda9091')), false)
    const context = target.context()
    const desktop = { ...context, target: { ...context.target!, profile: 'custom-desktop', surface: 'desktop' as const } }
    await assert.rejects(runProfileInstall(options, desktop), /Web only/)
  } finally { removeDir(base) }
})
it('L3 default patch is read from tarball and cannot insert or configure another plugin', () => {
  const pkg = packageFixture(), manifest = JSON.parse(pkg.files['package.json']!)
  manifest.dshPlugin = { profileDefaults: './profile.defaults.patch.yml' }
  pkg.files['package.json'] = JSON.stringify(manifest)
  pkg.files['profile.defaults.patch.yml'] = "- id: alpha\n  name: '@mbda9091/alpha'\n  config: { enabled: true }\n"
  assert.equal(packageDefaults(readPackage(tarball(pkg.files))).rows.length, 1)
  pkg.files['profile.defaults.patch.yml'] = '- insert: []\n'
  assert.throws(() => packageDefaults(readPackage(tarball(pkg.files))), /invalid default/)
})
