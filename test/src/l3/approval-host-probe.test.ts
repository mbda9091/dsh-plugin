import assert from 'node:assert/strict'
import { it } from 'node:test'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadApprovalProbeArtifacts, runApprovalHostProbe } from '../../../scripts/.build/commands/approval-host-probe.js'
import { assertArtifactsUnchanged, describeArtifact, loadArtifacts, newBatch, publishManifest, sourceState } from '../../../scripts/.build/core/artifacts.js'
import { checkInstalledPackage } from '../../../scripts/.build/core/artifact-package.js'
import { installArtifactPackages } from '../../../scripts/.build/core/artifact-harness.js'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { configuredDsh, loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import { digest } from '../../../scripts/.build/core/config-transaction.js'
import { packageFixture, tarball } from '../harness/artifacts.js'
import { configFixture } from '../harness/local-config.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

function approvalFiles(surface = 'web', platform = 'mac') {
  const { files, manifest } = packageFixture()
  manifest.name = '@local/approval-allowlist'
  manifest.dsh.targets = { surfaces: [surface], platforms: [platform] }
  files['package.json'] = JSON.stringify(manifest)
  files['lib/index.js'] = "export const name='approval-allowlist'; export function apply() {}"
  files['cordis.patch.yml'] = "- insert:\n    - id: approval-allowlist\n      name: '@local/approval-allowlist'\n"
  files['locale/en.json'] = JSON.stringify({ meta: { title: 'Approval', description: `[${surface === 'web' ? 'Web' : 'Desktop'} · ${platform === 'mac' ? 'macOS' : 'Windows'}] Test` } })
  files['locale/zh.json'] = JSON.stringify({ meta: { title: '审批', description: `【${surface === 'web' ? 'Web' : '桌面'} · ${platform === 'mac' ? 'macOS' : 'Windows'}】测试` } })
  return files
}

/** Synthetic package fixtures only, not a release pack or real-host acceptance. */
function manifestFixture(root: string, files = approvalFiles(), companion = false) {
  const { batch, directory } = newBatch(root)
  const archives = [{ name: 'approval.tgz', files }, ...(companion ? [{ name: 'alpha.tgz', files: packageFixture().files }] : [])]
  const packages = archives.map(({ name, files }) => {
    writeFileSync(join(directory, name), tarball(files))
    return describeArtifact(join(directory, name), name)
  })
  return publishManifest(root, { version: 1, batch, createdAt: new Date().toISOString(), source: sourceState(root),
    tools: { node: process.version, pnpm: '11.28.5' }, packages })
}

it('L3 approval probe preserves full manifest identity and rejects wrong/missing manifests and package hashes', () => {
  const root = makeTempDir('approval-manifest')
  try {
    const path = manifestFixture(root, approvalFiles(), true)
    const { set, item } = loadApprovalProbeArtifacts(root, path)
    assert.equal(set.manifest.packages.length, 2)
    assert.equal(set.hash, digest(readFileSync(path)))
    assert.equal(item.name, '@local/approval-allowlist')
    assert.throws(() => loadApprovalProbeArtifacts(root, join(dirname(path), 'missing.json')), /ENOENT/)
    const valid = readFileSync(path)
    writeFileSync(path, '{broken')
    assert.throws(() => loadApprovalProbeArtifacts(root, path), SyntaxError)
    writeFileSync(path, JSON.stringify({ ...set.manifest, version: 2 }))
    assert.throws(() => loadApprovalProbeArtifacts(root, path), /invalid\/future/)
    writeFileSync(path, valid)
    writeFileSync(join(dirname(path), 'alpha.tgz'), 'tampered unselected package')
    assert.throws(() => loadApprovalProbeArtifacts(root, path), /artifact hash changed: @local\/alpha/)
    const fresh = manifestFixture(root)
    const approval = loadApprovalProbeArtifacts(root, fresh)
    writeFileSync(join(dirname(fresh), approval.item.path), 'tampered approval package')
    assert.throws(() => loadApprovalProbeArtifacts(root, fresh), /artifact hash changed/)
    const missing = manifestFixture(root, packageFixture().files)
    assert.throws(() => loadApprovalProbeArtifacts(root, missing), /must contain @local\/approval-allowlist/)
    assert.equal(existsSync(join(root, '.local')), false)
  } finally { removeDir(root) }
})

it('L3 approval probe rejects incompatible targets, stale source/batches and manifest replacement', () => {
  const root = makeTempDir('approval-incompatible')
  try {
    for (const [surface, platform] of [['desktop', 'mac'], ['web', 'windows']]) {
      const path = manifestFixture(root, approvalFiles(surface, platform))
      assert.throws(() => loadApprovalProbeArtifacts(root, path), /incompatible with Web\/macOS/)
    }
    const path = manifestFixture(root), { set } = loadApprovalProbeArtifacts(root, path)
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    assert.throws(() => assertArtifactsUnchanged(set), /manifest changed during consumption/)
    manifestFixture(root)
    assert.throws(() => loadApprovalProbeArtifacts(root, path), /superseded/)
    const latest = manifestFixture(root)
    writeFileSync(join(root, 'changed-source.ts'), '// changed since pack')
    assert.throws(() => loadApprovalProbeArtifacts(root, latest), /source state changed/)
  } finally { removeDir(root) }
})

it('L3 approval manifest errors never fall back to source or initialize a profile', async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    const settings = loadCommandContext({}, f.root, f.env, 'test')
    mkdirSync(join(f.root, 'approval-allowlist/lib'), { recursive: true })
    writeFileSync(join(f.root, 'approval-allowlist/lib/index.js'), "throw Error('source must never load')")
    await assert.rejects(runApprovalHostProbe({ manifest: 'dist/batches/missing/manifest.json', keep: false, timeoutMs: 1000 }, settings), /ENOENT/)
    assert.equal(existsSync(join(f.root, '.tmp/approval-host-probe')), false)
    assert.equal(existsSync(join(f.root, 'dist/.artifact-lock')), false, 'failed preflight releases lock')
  } finally { removeDir(f.root) }
})

it('L3 approval fixed install selects only the declared package and rejects changed bytes and source links', { skip: process.platform !== 'darwin' }, async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    const trace = join(f.root, '.installed-packages')
    const parser = pathToFileURL(join(repoRoot, 'scripts/.build/core/artifact-package.js')).href
    // Fake manager for byte/selection regression; the real Web probe is intentionally NOT simulated here.
    writeFileSync(f.entry, `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
      import(${JSON.stringify(parser)}).then(({readPackage})=>{const p=readPackage(fs.readFileSync(args[4])),profile=process.env.DSH_PROFILE_DIR;
        fs.appendFileSync(${JSON.stringify(trace)},p.name+'\\n');
        for(const [file,bytes] of p.files){const dest=path.join(profile,'node_modules',p.name,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes)}
        fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dependencies:{[p.name]:'file:'+args[4]},dsh:{profile:{bundles:[p.name]}}}));
      }).catch(e=>{console.error(e);process.exitCode=1});`)
    const settings = loadCommandContext({}, f.root, f.env, 'test'), runDir = join(f.root, '.tmp/probe-install')
    mkdirSync(runDir, { recursive: true })
    const context = { settings, runner: configuredDsh(settings, true), runDir, home: join(runDir, 'home'), logDir: join(runDir, 'logs'), options: { timeoutMs: 10000 } }
    const incompatible = loadArtifacts(f.root, manifestFixture(f.root, approvalFiles('web', 'windows')))
    await assert.rejects(installArtifactPackages(context, incompatible, ['@local/approval-allowlist']), /missing or incompatible/)
    const path = manifestFixture(f.root, approvalFiles(), true), { set, pkg } = loadApprovalProbeArtifacts(f.root, path)
    await assert.rejects(installArtifactPackages(context, set, ['@local/unknown']), /missing or incompatible/)
    await assert.rejects(installArtifactPackages(context, set, []), /nonempty and unique/)
    await assert.rejects(installArtifactPackages(context, set, [pkg.name, pkg.name]), /nonempty and unique/)
    assert.equal(existsSync(trace), false)
    const evidence = JSON.parse(await installArtifactPackages(context, set, [pkg.name]))
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].sha256, set.manifest.packages[0]!.sha256)
    assert.equal(readFileSync(trace, 'utf8'), `${pkg.name}\n`)
    const profile = join(context.home, 'profiles/web')
    const actual = checkInstalledPackage(pkg, profile, f.root)
    writeFileSync(join(actual, 'lib/index.js'), '// replaced installed bytes')
    assert.throws(() => checkInstalledPackage(pkg, profile, f.root), /installed package content differs/)
    const source = join(f.root, 'approval-allowlist'), linkedProfile = join(runDir, 'linked-profile')
    mkdirSync(source, { recursive: true }); mkdirSync(join(linkedProfile, 'node_modules/@local'), { recursive: true })
    symlinkSync(source, join(linkedProfile, 'node_modules', pkg.name), 'dir')
    assert.throws(() => checkInstalledPackage(pkg, linkedProfile, f.root), /resolves to repository source/)
  } finally { removeDir(f.root) }
})
