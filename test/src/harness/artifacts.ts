import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeArtifact, loadArtifacts, newBatch, publishManifest, sourceState } from '../../../scripts/.build/core/artifacts.js'
import { artifactSteps } from '../../../scripts/.build/core/artifact-verification.js'
import type { Verification } from '../../../scripts/.build/core/artifact-verification.js'
import type { ArtifactSet } from '../../../scripts/.build/core/artifacts.js'
import type { TestReport } from '../../../scripts/.build/core/test-run.js'

/** Minimal real USTAR fixture: tests mutate bytes/metadata, not the validator. */
export function tarball(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), header = Buffer.alloc(512)
    header.write(`package/${path}`, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156)
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks))
}
export function packageFixture() {
  const manifest = { name: '@local/alpha', version: '1.0.0', type: 'module', exports: { '.': { default: './lib/index.js' }, './icon': './icon.svg' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, targets: { surfaces: ['web'], platforms: ['windows', 'mac'] } } }
  const files: Record<string, string> = { 'package.json': JSON.stringify(manifest), 'lib/index.js': "export const name='alpha'; export function apply() {}",
    'cordis.patch.yml': "- insert:\n    - id: alpha\n      name: '@local/alpha'\n", 'README.md': 'test Web plugin', 'icon.svg': '<svg/>',
    'locale/en.json': JSON.stringify({ meta: { title: 'Alpha', description: '[Web · All platforms] Test' } }),
    'locale/zh.json': JSON.stringify({ meta: { title: 'Alpha', description: '【Web · 通用平台】测试' } }) }
  return { manifest, files }
}
export function artifactFixture(root: string, bytes = tarball(packageFixture().files)): ArtifactSet {
  const { batch, directory } = newBatch(root), file = 'local-alpha-1.0.0.tgz'
  writeFileSync(join(directory, file), bytes)
  const path = publishManifest(root, { version: 1, batch, createdAt: new Date().toISOString(), source: sourceState(root), tools: { node: process.version, pnpm: '11.28.5' }, packages: [describeArtifact(join(directory, file), file)] })
  return loadArtifacts(root, path)
}
export function verificationFixture(set: ArtifactSet): Verification {
  const startedAt = new Date().toISOString(), platform = process.platform === 'win32' ? 'windows' : 'mac'
  const report: TestReport = { version: 1, kind: 'l4', ok: true, runDir: 'removed', platform: process.platform, node: process.version, startedAt, finishedAt: startedAt, cleanup: 'removed',
    steps: artifactSteps.l4.map(name => ({ name, ok: true, durationMs: 1, detail: name === 'package-contracts' ? set.hash : name === 'install-artifacts' ? JSON.stringify(set.manifest.packages.filter(p => p.surfaces.includes('web') && p.platforms.includes(platform)).map(p => ({ name: p.name, sha256: p.sha256, actual: 'isolated/store/' + p.name }))) : 'checked' })) }
  return { version: 1, batch: set.manifest.batch, manifestSha256: set.hash, sourceSha256: set.manifest.source.sha256, startedAt, finishedAt: startedAt, status: 'passed',
    tools: { node: process.version, pnpm: '11.28.5', dsh: '0.2.1-rc.2' }, platform, surface: 'web', contracts: set.manifest.packages.map(p => ({ name: p.name, sha256: p.sha256, status: 'passed' })),
    environment: [{ kind: 'l4', cleanup: 'removed', steps: ['context', 'profile-init', 'install-artifacts', 'cleanup'] }], functions: { l4: report },
    coverage: set.manifest.packages.flatMap(p => p.surfaces.flatMap(surface => p.platforms.map(scope => ({ name: p.name, sha256: p.sha256, platform: scope, surface, host: '0.2.1-rc.2', status: scope === platform && surface === 'web' ? 'passed' as const : 'uncovered' as const, reason: 'test fixture' })))) }
}
