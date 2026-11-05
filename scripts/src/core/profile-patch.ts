import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isSeq, parseDocument, stringify } from 'yaml'
import { isRecord } from './json.js'
import { plainPath } from './daily-contract.js'
import type { PackageContent } from './artifact-package.js'

export interface Defaults { name: string; rows: Record<string, unknown>[] }
const parse = (text: string) => {
  const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (doc.errors.length || doc.warnings.length) throw new Error('invalid or unsupported patch YAML')
  if (!isSeq(doc.contents)) throw new Error('patch must be a YAML array')
  return doc
}
export function packageDefaults(pkg: PackageContent): Defaults {
  const manifest = JSON.parse(pkg.files.get('package.json')!.toString())
  if (manifest.dshPlugin?.profileDefaults !== './profile.defaults.patch.yml') throw new Error(`missing default patch metadata: ${pkg.name}`)
  const bytes = pkg.files.get('profile.defaults.patch.yml')
  if (!bytes) throw new Error(`missing default patch: ${pkg.name}`)
  const doc = parse(bytes.toString())
  if (/!!|!<|[&*][\w-]+/.test(bytes.toString())) throw new Error('default patch must contain plain YAML data')
  const rows: unknown[] = doc.toJS()
  if (rows.length > 1 || rows.some(row => !isRecord(row) || row.id !== pkg.name.split('/').at(-1) || row.name !== pkg.name
    || !isRecord(row.config) || Object.keys(row).some(k => !['id', 'name', 'config'].includes(k)))) throw new Error(`invalid default rows: ${pkg.name}`)
  return { name: pkg.name, rows: rows as Record<string, unknown>[] }
}
export function mergeDefaults(before: string | null, defaults: readonly Defaults[]): { text: string; added: string[]; preserved: string[] } {
  const original = before ?? '[]\n', doc = parse(original)
  const rows: unknown[] = doc.toJS(), ids = new Set<string>()
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || ids.has(row.id) || (row.name !== undefined && row.name !== `@mbda9091/${row.id}`)
      || Object.keys(row).some(k => !['id', 'name', 'config', 'disabled'].includes(k))) throw new Error('conflicting or unsupported namespace patch row')
    ids.add(row.id)
  }
  const added: string[] = [], preserved: string[] = [], append: Record<string, unknown>[] = []
  for (const item of defaults) for (const row of item.rows) {
    if (ids.has(row.id as string)) preserved.push(item.name)
    else { ids.add(row.id as string); append.push(row); added.push(item.name) }
  }
  if (!append.length) return { text: original, added, preserved }
  if (!isSeq(doc.contents)) throw new Error('patch must be array')
  const range = doc.contents.range!
  let text: string
  if (rows.length === 0) text = original.slice(0, range[0]) + stringify(append).trimEnd() + original.slice(range[1])
  else {
    if (doc.contents.flow) throw new Error('cannot append to a nonempty flow array without rewriting user YAML')
    // Insert before the document-end marker, preserving every existing byte.
    const endMarker = /^\.\.\.(?:[ \t]*(?:#.*)?)?\r?$/m.exec(original)
    const at = endMarker?.index ?? original.length
    const prefix = original.slice(0, at)
    text = prefix + (prefix.endsWith('\n') ? '' : '\n') + stringify(append) + original.slice(at)
  }
  const mergedRows: unknown[] = parse(text).toJS()
  if (!isDeepStrictEqual(mergedRows, [...rows, ...append])) throw new Error('cannot append defaults without changing existing patch values')
  return { text, added, preserved }
}
export function planProfilePatch(profile: string, defaults: readonly Defaults[]) {
  const path = join(profile, 'mbda9091/cordis.patch.yml'), root = join(profile, 'cordis.patch.yml')
  plainPath(path); plainPath(root)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const rootBefore = existsSync(root) ? readFileSync(root, 'utf8') : null
  const merged = mergeDefaults(before, defaults)
  return { path, root, before, rootBefore, ...merged }
}
export function commitProfilePatch(plan: ReturnType<typeof planProfilePatch>): string | null {
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null
  for (const path of [plan.path, plan.root]) plainPath(path)
  if (read(plan.path) !== plan.before || read(plan.root) !== plan.rootBefore) throw new Error('profile patch changed during installation; retry')
  if (plan.before === plan.text) return null
  mkdirSync(dirname(plan.path), { recursive: true })
  const backup = `${plan.path}.bak`, candidate = `${plan.path}.${randomUUID()}.tmp`
  try {
    if (plan.before !== null) {
      plainPath(backup)
      if (existsSync(backup)) writeFileSync(`${backup}.${randomUUID()}`, readFileSync(backup), { flag: 'wx', mode: 0o600 })
      writeFileSync(backup, plan.before, { mode: 0o600 })
    }
    writeFileSync(candidate, plan.text, { flag: 'wx', mode: plan.before === null ? 0o600 : statSync(plan.path).mode & 0o777 })
    plainPath(plan.path)
    if (read(plan.path) !== plan.before || read(plan.root) !== plan.rootBefore) throw new Error('profile patch changed during commit')
    renameSync(candidate, plan.path)
    if (read(plan.path) !== plan.text || read(plan.root) !== plan.rootBefore) throw new Error('profile patch readback mismatch')
    return plan.before === null ? null : backup
  } finally { if (existsSync(candidate)) unlinkSync(candidate) }
}
