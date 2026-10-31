import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRecord } from './json.js'

/** Runtime contract: no repository discovery, config defaults or tool lookup. */
export interface DailyConfig {
  version: 1
  instanceId: string
  host: { node: string; nodeVersion: string; cli: string; entry: string; version: string; hashes: Record<string, string> }
  target: { home: string; profile: string; directory: string; surface: 'web'; platform: 'windows' }
  packageManager: { script: string; version: string; sha256: string }
  web: { host: string; port: number; openBrowser: boolean; browserPath: string | null; startupTimeoutMs: number }
  isolation: { forbiddenRoots: string[] }
}
export const dailyHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export function inside(base: string, path: string): boolean {
  const r = relative(resolve(base), resolve(path))
  return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)
}
/** Every existing component is checked, including dangling junctions. */
export function plainPath(path: string): void {
  if (!isAbsolute(path)) throw new Error('daily paths must be absolute')
  let current = resolve(path)
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`daily path is a link: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
export function separateDaily(root: string, forbidden: readonly string[]): void {
  plainPath(root)
  for (const path of forbidden) if (inside(path, root) || inside(root, path)) throw new Error(`daily paths overlap: ${root} / ${path}`)
}
export function readDailyConfig(path: string): DailyConfig {
  plainPath(path)
  let v: unknown
  try { v = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('invalid daily configuration JSON') }
  if (!isRecord(v) || v.version !== 1 || typeof v.instanceId !== 'string' || !/^[a-f\d-]{36}$/.test(v.instanceId)
    || !isRecord(v.host) || !isRecord(v.target) || !isRecord(v.packageManager) || !isRecord(v.web) || !isRecord(v.isolation)) throw new Error('invalid daily configuration version/shape')
  const h = v.host, t = v.target, p = v.packageManager, w = v.web
  for (const value of [h.node, h.cli, h.entry, t.home, t.directory, p.script]) if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('invalid daily absolute path')
  if (typeof h.nodeVersion !== 'string' || !/^24\./.test(h.nodeVersion) || typeof h.version !== 'string' || !isRecord(h.hashes)
    || [h.node, h.cli, h.entry].some(path => typeof path !== 'string' || !/^[a-f\d]{64}$/.test(String((h.hashes as Record<string, unknown>)[path])))
    || t.surface !== 'web' || t.platform !== 'windows' || typeof t.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(t.profile)
    || t.directory !== join(String(t.home), 'profiles', t.profile) || typeof p.version !== 'string' || !/^[a-f\d]{64}$/.test(String(p.sha256))
    || !['127.0.0.1', 'localhost', '::1'].includes(String(w.host)) || !Number.isInteger(w.port) || Number(w.port) < 0 || Number(w.port) > 65535
    || typeof w.openBrowser !== 'boolean' || !(w.browserPath === null || typeof w.browserPath === 'string' && isAbsolute(w.browserPath))
    || !Number.isInteger(w.startupTimeoutMs) || Number(w.startupTimeoutMs) < 1 || Number(w.startupTimeoutMs) > 2147483647
    || !Array.isArray(v.isolation.forbiddenRoots) || !v.isolation.forbiddenRoots.length || v.isolation.forbiddenRoots.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('invalid daily configuration fields')
  return v as unknown as DailyConfig
}
export function validateDailyLocation(root: string, c: DailyConfig): void {
  separateDaily(root, [...c.isolation.forbiddenRoots, c.target.home])
  separateDaily(c.target.home, c.isolation.forbiddenRoots)
  for (const path of [c.target.directory, join(c.target.directory, 'package.json')]) plainPath(path)
}
export function validateDailyTools(c: DailyConfig): void {
  if (process.platform !== 'win32' || process.versions.electron || process.versions.node !== c.host.nodeVersion || realpathSync(process.execPath) !== c.host.node) throw new Error('bound ordinary Windows Node changed; explicitly redeploy and verify')
  for (const path of [c.host.node, c.host.cli, c.host.entry, c.packageManager.script]) {
    separateDaily(path, c.isolation.forbiddenRoots)
    if (realpathSync(path) !== path) throw new Error('daily tool real path changed; explicitly rebind')
  }
  for (const [path, hash] of Object.entries(c.host.hashes)) {
    separateDaily(path, c.isolation.forbiddenRoots)
    if (dailyHash(readFileSync(path)) !== hash) throw new Error('bound daily host bytes changed; explicitly rebind and verify')
  }
  const p = c.packageManager
  const metadata = JSON.parse(readFileSync(join(dirname(dirname(p.script)), 'package.json'), 'utf8'))
  if (p.script !== join(dirname(dirname(p.script)), 'bin/pnpm.cjs') || metadata.name !== 'pnpm' || metadata.version !== p.version || dailyHash(readFileSync(p.script)) !== p.sha256) throw new Error('bound pnpm changed; explicitly rebind')
}
export interface DailyFinding { kind: 'blocked' | 'review'; location: string; reason: string }
/** Conservative audit: no secrets or YAML values appear in diagnostics. */
export function auditDaily(c: DailyConfig): { findings: DailyFinding[]; dependencies: { name: string; kind: string; actual?: string }[] } {
  const findings: DailyFinding[] = [], dependencies: { name: string; kind: string; actual?: string }[] = []
  const forbidden = (path: string) => c.isolation.forbiddenRoots.some(root => inside(root, path))
  const textReference = (text: string) => {
    const normalized = text.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase()
    return c.isolation.forbiddenRoots.some(root => normalized.includes(root.replaceAll('\\', '/').toLowerCase()))
  }
  const visited = new Set<string>()
  const inspectDependencies = (directory: string) => {
    if (visited.has(directory)) return
    visited.add(directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    for (const [name, raw] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof raw !== 'string') { findings.push({ kind: 'blocked', location: directory, reason: 'invalid dependency' }); continue }
      const spec = raw, location = `${directory}:${name}`
      if (/^(link:|workspace:)/.test(spec) || textReference(spec)) findings.push({ kind: 'blocked', location, reason: 'source dependency' })
      if (spec.startsWith('file:')) {
        const source = resolve(directory, spec.slice(5))
        try { plainPath(source); if (!source.endsWith('.tgz') || forbidden(source) || !existsSync(source)) throw new Error() }
        catch { findings.push({ kind: 'blocked', location, reason: 'local source missing, linked or not a fixed external tarball' }) }
      }
      try {
        const link = join(directory, 'node_modules', name), actual = realpathSync(link)
        dependencies.push({ name, kind: spec.startsWith('file:') ? 'file' : spec.startsWith('link:') ? 'link' : 'registry', actual })
        if (forbidden(actual)) findings.push({ kind: 'blocked', location, reason: 'installed dependency resolves into forbidden root' })
        else {
          if (lstatSync(link).isSymbolicLink() && !actual.split(sep).some(part => part === '.pnpm' || part === '.pnpm-store')) findings.push({ kind: 'review', location, reason: 'unknown external package link' })
          inspectDependencies(actual)
          const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue
            const file = join(dir, e.name)
            if (e.isSymbolicLink()) findings.push({ kind: 'blocked', location: file, reason: 'linked runtime resource' })
            else if (e.isDirectory()) walk(file)
            else if (/\.(?:js|cjs|mjs|json|ya?ml)$/.test(e.name) && textReference(readFileSync(file, 'utf8'))) findings.push({ kind: 'blocked', location: file, reason: 'runtime resource references forbidden root' })
          } }; walk(actual)
        }
      } catch { findings.push({ kind: 'blocked', location, reason: 'dependency missing or unreadable' }) }
    }
  }
  inspectDependencies(c.target.directory)
  for (const directory of [c.target.home, c.target.directory]) for (const e of readdirSync(directory, { withFileTypes: true })) {
    // Do not read credentials or session content, even for an audit.
    if (!/^cordis.*\.ya?ml$/.test(e.name)) continue
    const file = join(directory, e.name)
    plainPath(file)
    const text = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
    if (textReference(text)) findings.push({ kind: 'blocked', location: file, reason: 'configuration references forbidden root' })
    if (/!!?js|\$\{|\b(?:root|path|file|include|extends)\s*:|(?:[A-Za-z]:[\\/]|file:)/.test(text)) findings.push({ kind: 'review', location: file, reason: 'dynamic expression or local configuration resource requires manual review' })
  }
  return { findings, dependencies }
}
