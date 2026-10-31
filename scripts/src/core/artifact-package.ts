import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, matchesGlob, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest } from './config-transaction.js'
import { isRecord } from './json.js'
import { runToFiles } from './exec.js'
import { platformLabel, surfaceLabel } from './targets.js'

export interface PackageContent {
  name: string; version: string; surfaces: string[]; platforms: string[]; client: boolean
  files: Map<string, Buffer>; hashes: Record<string, string>; entry: string
}

/** Read regular npm tar members without invoking an extractor or following links.
 * Restrict the archive dialect deliberately: pnpm's USTAR output needs no links.
 */
export function readPackage(bytes: Buffer): PackageContent {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
  const files = new Map<string, Buffer>(), names = new Set<string>()
  const field = (header: Buffer, start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '')
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = Number.parseInt(field(header, 124, 136).trim(), 8)
    const checksum = Number.parseInt(field(header, 148, 156).trim(), 8)
    const sum = header.reduce((value, byte, i) => value + (i >= 148 && i < 156 ? 32 : byte), 0)
    if (checksum !== sum || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('invalid tar header/size/checksum')
    const prefix = field(header, 345, 500), name = (prefix ? `${prefix}/` : '') + field(header, 0, 100)
    const type = field(header, 156, 157)
    if (!['', '0', '5'].includes(type)) throw new Error(`unsupported tar member (links forbidden): ${name}`)
    const path = name.replace(/\/$/, '')
    if (!path.startsWith('package/') && path !== 'package') throw new Error(`archive path outside package: ${name}`)
    const local = path.slice(8)
    if (local && (/[\\:\x00-\x1f]/.test(local) || local.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)))) throw new Error(`unsafe archive path: ${name}`)
    if (local && names.has(local.toLowerCase())) throw new Error(`duplicate archive path: ${name}`)
    names.add(local.toLowerCase())
    if (type !== '5') files.set(local, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const required = (path: string) => { const bytes = files.get(path); if (!bytes) throw new Error(`package missing ${path}`); return bytes }
  const manifest: unknown = JSON.parse(required('package.json').toString())
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || !/^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)
    || manifest.type !== 'module' || !isRecord(manifest.dsh) || !isRecord(manifest.dsh.targets) || !isRecord(manifest.dsh.bundle)) throw new Error('invalid plugin package metadata')
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (manifest[key] && Object.keys(manifest[key] as object).length) throw new Error(`artifact must be self-contained; runtime ${key} forbidden (including DSH/workspace dependencies)`)
  }
  const targets = (value: unknown, allowed: string[]) => {
    if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(v => typeof v !== 'string' || !allowed.includes(v))) throw new Error('invalid artifact targets')
    return value as string[]
  }
  const surfaces = targets(manifest.dsh.targets.surfaces, ['desktop', 'web'])
  const platforms = targets(manifest.dsh.targets.platforms, ['windows', 'mac'])
  for (const path of files.keys()) {
    if (path.split('/').some(p => p.startsWith('.') || ['node_modules', 'src', 'scripts', 'profiles', 'dist'].includes(p))
      || /(?:^|\/)(?:local\.json|.*credentials.*|.*\.npmrc|pnpm-lock\.yaml|cordis\.(?:local|dev)\.patch\.yml)$/i.test(path)) throw new Error(`forbidden packaged file: ${path}`)
  }
  const exports = manifest.exports
  if (!isRecord(exports) || !isRecord(exports['.']) || typeof exports['.'].default !== 'string') throw new Error('missing compiled Host export')
  const entry = exports['.'].default
  if (!entry.startsWith('./lib/') || !entry.endsWith('.js')) throw new Error('Host entry must use lib/*.js')
  const checkExport = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.startsWith('./') || ![...files.keys()].some(p => matchesGlob(p, value.slice(2)))) throw new Error(`missing/unsafe export: ${value}`)
    } else if (isRecord(value) || Array.isArray(value)) Object.values(value).forEach(checkExport)
    else throw new Error('invalid export target')
  }
  checkExport(exports)
  if (typeof manifest.dsh.bundle.patch !== 'string') throw new Error('missing bundle patch')
  const patch = required(manifest.dsh.bundle.patch.replace(/^\.\//, '')).toString()
  if (!patch.includes(`id: ${manifest.name.slice(7)}`) || !patch.includes(manifest.name) || !/^\s*- insert:/m.test(patch)) throw new Error('bundle patch does not insert its plugin')
  required('README.md')
  for (const lang of ['en', 'zh'] as const) {
    const locale: unknown = JSON.parse(required(`locale/${lang}.json`).toString())
    const prefix = lang === 'zh' ? `【${surfaceLabel(surfaces, lang)} · ${platformLabel(platforms, lang)}】` : `[${surfaceLabel(surfaces, lang)} · ${platformLabel(platforms, lang)}]`
    if (!isRecord(locale) || !isRecord(locale.meta) || typeof locale.meta.title !== 'string' || !locale.meta.title || typeof locale.meta.description !== 'string' || !locale.meta.description.startsWith(prefix)) throw new Error(`invalid ${lang} locale/targets prefix`)
  }
  if (typeof exports['./icon'] !== 'string' || required(exports['./icon'].replace(/^\.\//, '')).length > 256 * 1024) throw new Error('missing/oversized icon')
  if (manifest.dsh.client && typeof exports['./client'] !== 'string') throw new Error('missing client export')
  for (const [path, bytes] of files) if (path.endsWith('.js') && /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:@local\/|@deepseek-ai\/|\.\.\/\.\.\/)/.test(bytes.toString())) throw new Error(`non-self-contained runtime import: ${path}`)
  return { name: manifest.name, version: manifest.version, surfaces, platforms, client: !!manifest.dsh.client, entry,
    files, hashes: Object.fromEntries([...files].map(([path, bytes]) => [path, digest(bytes)])) }
}

export function checkPackageImports(pkg: PackageContent, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const [path, bytes] of pkg.files) { mkdirSync(dirname(join(destination, path)), { recursive: true }); writeFileSync(join(destination, path), bytes, { flag: 'wx' }) }
  const script = `const p=await import(${JSON.stringify(pathToFileURL(join(destination, pkg.entry)).href)});if(typeof p.apply!=='function'||p.name!==${JSON.stringify(pkg.name.slice(7))}||p.default!==undefined)throw Error('invalid Host module exports')`
  for (const preserve of [false, true]) {
    const result = runToFiles(process.execPath, [...preserve ? ['--preserve-symlinks'] : [], '--input-type=module', '--eval', script], {
      cwd: destination, timeoutMs: 30_000, stdoutPath: join(destination, `import-${preserve}.out`), stderrPath: join(destination, `import-${preserve}.err`),
    })
    if (result.status !== 0 || result.timedOut) throw new Error(`packed import failed: ${result.stderr}`)
  }
}

/** Packing must preserve every built module/resource, including non-exported ones.
 * This check runs only at pack time; acceptance never depends on source lib/.
 */
export function checkPackedSource(source: string, pkg: PackageContent): void {
  const original = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const packed = JSON.parse(pkg.files.get('package.json')!.toString())
  for (const key of ['name', 'version', 'type', 'exports', 'dsh']) if (JSON.stringify(original[key]) !== JSON.stringify(packed[key])) throw new Error(`packed metadata differs from source: ${key}`)
  const walk = (directory: string) => { for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isSymbolicLink()) throw new Error(`source runtime resource is a link: ${path}`)
    if (item.isDirectory()) walk(path)
    else {
      const file = relative(source, path).replaceAll('\\', '/')
      if (pkg.hashes[file] !== digest(readFileSync(path))) throw new Error(`tarball missing or changed runtime resource: ${file}`)
    }
  } }
  for (const directory of ['lib', 'locale']) if (existsSync(join(source, directory))) walk(join(source, directory))
}

/** A normal pnpm store link is fine; repository source and differing bytes are not. */
export function checkInstalledPackage(pkg: PackageContent, profile: string, root: string): string {
  const installed = join(profile, 'node_modules', pkg.name)
  const source = join(root, pkg.name.slice(7))
  const actual = realpathSync(installed)
  const under = (base: string, path: string) => { const rel = relative(base, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') }
  if (under(source, actual)) throw new Error(`installed package resolves to repository source: ${actual}`)
  for (const [file, hash] of Object.entries(pkg.hashes)) {
    const path = join(actual, file)
    if (!existsSync(path) || !under(actual, realpathSync(path)) || digest(readFileSync(path)) !== hash) throw new Error(`installed package content differs: ${pkg.name}/${file}`)
  }
  const found: string[] = []
  const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isSymbolicLink()) throw new Error(`unexpected link inside installed package: ${path}`)
    if (item.isDirectory()) walk(path); else found.push(relative(actual, path).replaceAll('\\', '/'))
  } }; walk(actual)
  if (JSON.stringify(found.sort()) !== JSON.stringify(Object.keys(pkg.hashes).sort())) throw new Error(`unexpected installed files: ${pkg.name}`)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  if (typeof manifest.dependencies?.[pkg.name] !== 'string' || !manifest.dependencies[pkg.name].endsWith('.tgz') || !manifest.dsh?.profile?.bundles?.includes(pkg.name)) throw new Error(`not a registered tarball bundle: ${pkg.name}`)
  return actual
}
