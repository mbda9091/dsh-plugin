import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { digest, safeConfigPath } from './config-transaction.js'
import { runToFiles } from './exec.js'
import { readPackage } from './artifact-package.js'
import type { PackageContent } from './artifact-package.js'

export interface SourceState { commit: string | null; dirty: string; sha256: string; files: Record<string, string>; build: string | null }
export interface Artifact { path: string; name: string; version: string; sha256: string; surfaces: string[]; platforms: string[]; client: boolean; files: Record<string, string> }
export interface ArtifactManifest { version: 1; batch: string; createdAt: string; source: SourceState; tools: { node: string; pnpm: string }; packages: Artifact[] }
export interface ArtifactSet { root: string; path: string; hash: string; manifest: ArtifactManifest; packages: Map<string, PackageContent> }
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

export function sourceState(root: string): SourceState {
  const base = join(root, '.tmp/artifact-source'); safeConfigPath(root, base); mkdirSync(base, { recursive: true })
  const scratch = mkdtempSync(join(base, 'read-'))
  const git = (args: string[]) => {
    const result = runToFiles('git', ['-C', root, ...args], { timeoutMs: 30_000, stdoutPath: join(scratch, 'out'), stderrPath: join(scratch, 'err') })
    if (result.status !== 0) throw new Error(`cannot capture source state: ${result.stderr}`)
    return result.stdout
  }
  try {
    let commit: string | null = null, dirty = 'no git metadata', paths: string[] = []
    if (existsSync(join(root, '.git'))) {
      commit = git(['rev-parse', 'HEAD']).trim(); dirty = git(['status', '--porcelain=v1', '--untracked-files=all'])
      paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    } else {
      const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', 'lib', 'dist', 'simulated-user'].includes(entry.name) || entry.name === 'local.json') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path); else paths.push(relative(root, path).replaceAll('\\', '/'))
      } }; walk(root)
    }
    const files: Record<string, string> = {}
    for (const path of [...new Set(paths)].sort()) {
      const absolute = join(root, path)
      files[path] = !existsSync(absolute) ? 'deleted' : lstatSync(absolute).isSymbolicLink() ? `link:${readlinkSync(absolute)}` : digest(readFileSync(absolute))
    }
    const marker = join(root, 'dist/build-generation')
    return { commit, dirty, files, sha256: digest(JSON.stringify(files)), build: existsSync(marker) ? readFileSync(marker, 'utf8') : null }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export function artifactLock(root: string): () => void {
  const dist = join(root, 'dist'); safeConfigPath(root, dist); mkdirSync(dist, { recursive: true })
  const path = join(dist, '.artifact-lock'); safeConfigPath(root, path)
  try { writeFileSync(path, json({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' }) }
  catch { throw new Error(`artifact operation locked: ${path}; stop the owning process before removing a stale lock`) }
  return () => rmSync(path)
}

export function newBatch(root: string): { batch: string; directory: string } {
  const batch = randomUUID(), directory = join(root, 'dist/batches', batch)
  safeConfigPath(root, directory); mkdirSync(directory, { recursive: true })
  return { batch, directory }
}
export function publishManifest(root: string, manifest: ArtifactManifest): string {
  const path = join(root, 'dist/batches', manifest.batch, 'manifest.json')
  safeConfigPath(root, path); writeFileSync(path, json(manifest), { flag: 'wx' })
  const pointer = join(root, 'dist', `current-${manifest.batch}.json`)
  writeFileSync(pointer, json({ version: 1, batch: manifest.batch, manifest: relative(join(root, 'dist'), path).replaceAll('\\', '/') }), { flag: 'wx' })
  safeConfigPath(root, join(root, 'dist/current.json')); renameSync(pointer, join(root, 'dist/current.json'))
  return path
}
export function describeArtifact(path: string, relativePath: string): Artifact {
  const bytes = readFileSync(path), pkg = readPackage(bytes)
  return { path: relativePath, name: pkg.name, version: pkg.version, sha256: digest(bytes), surfaces: pkg.surfaces, platforms: pkg.platforms, client: pkg.client, files: pkg.hashes }
}
export function loadArtifacts(root: string, input: string, current = true): ArtifactSet {
  const path = resolve(root, input); safeConfigPath(join(root, 'dist/batches'), path)
  const bytes = readFileSync(path), manifest = JSON.parse(bytes.toString()) as ArtifactManifest
  if (manifest.version !== 1 || !/^[a-f\d-]{36}$/.test(manifest.batch) || path !== join(root, 'dist/batches', manifest.batch, 'manifest.json')
    || !manifest.source || typeof manifest.source.sha256 !== 'string' || !Array.isArray(manifest.packages) || !manifest.packages.length) throw new Error('invalid/future artifact manifest')
  if (current) {
    const pointer = JSON.parse(readFileSync(join(root, 'dist/current.json'), 'utf8'))
    if (pointer.version !== 1 || pointer.batch !== manifest.batch) throw new Error('artifact batch superseded by a new pack')
    const source = sourceState(root)
    if (source.sha256 !== manifest.source.sha256 || source.commit !== manifest.source.commit || source.dirty !== manifest.source.dirty || source.build !== manifest.source.build) throw new Error('source state changed or rebuilt since pack; build and pack a new batch')
  }
  const packages = new Map<string, PackageContent>()
  for (const item of manifest.packages) {
    if (typeof item.path !== 'string' || !/^[a-z0-9._-]+\.tgz$/.test(item.path) || packages.has(item.name)) throw new Error('invalid/duplicate artifact path or name')
    const archive = join(dirname(path), item.path); safeConfigPath(root, archive)
    const bytes = readFileSync(archive)
    if (digest(bytes) !== item.sha256) throw new Error(`artifact hash changed: ${item.name}`)
    const pkg = readPackage(bytes)
    if (JSON.stringify(describeArtifact(archive, item.path)) !== JSON.stringify(item)) throw new Error(`artifact metadata/content mismatch: ${item.name}`)
    packages.set(pkg.name, pkg)
  }
  return { root, path, hash: digest(bytes), manifest, packages }
}
export function assertArtifactsUnchanged(set: ArtifactSet): void {
  const next = loadArtifacts(set.root, set.path)
  if (next.hash !== set.hash) throw new Error('artifact manifest changed during consumption')
}
/** Snapshot private inputs before invoking a consumer; check both sides afterwards. */
export function copyArtifact(set: ArtifactSet, item: Artifact, destination: string): string {
  assertArtifactsUnchanged(set); safeConfigPath(set.root, destination)
  mkdirSync(dirname(destination), { recursive: true })
  const bytes = readFileSync(join(dirname(set.path), item.path))
  if (digest(bytes) !== item.sha256) throw new Error('artifact changed before snapshot')
  writeFileSync(destination, bytes, { flag: 'wx' })
  return destination
}
export function assertConsumed(set: ArtifactSet, item: Artifact, path: string): void {
  if (digest(readFileSync(path)) !== item.sha256) throw new Error('artifact changed during consumption')
  assertArtifactsUnchanged(set)
}
