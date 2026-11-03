import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord, matchesSubset } from './rules.js'

export type GrantScope = 'project' | 'permanent'
export interface Grant {
  id: string
  scope: GrantScope
  projectRoot?: string
  tool: 'write' | 'edit' | 'bash'
  path?: string
  arguments: Record<string, unknown>
  maxUses?: number
  used?: number
  expiresAt?: string
  note?: string
}
export interface GrantsFile { version: 1; rules: Grant[] }
const keys = new Set(['id', 'scope', 'projectRoot', 'tool', 'path', 'arguments', 'maxUses', 'used', 'expiresAt', 'note'])
/** Canonicalize existing ancestors; dangling links and inaccessible paths fail closed. */
function canonical(path: string): string {
  try { return realpathSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(canonical(parent), relative(parent, path))
  }
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}
function absolute(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || !isAbsolute(value)) return false
  // Ambiguous dot segments can change meaning across symlink ancestors.
  if (value.split(process.platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '..' || part === '.')) return false
  if (process.platform !== 'win32') return true
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\(?![?.]\\)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
}
export function normalizeGrant(value: unknown): Grant | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.has(key))) return undefined
  if (typeof value.id !== 'string' || !/^[\w-]{1,100}$/.test(value.id)) return undefined
  if (value.scope !== 'project' && value.scope !== 'permanent') return undefined
  if (value.scope === 'project' ? !absolute(value.projectRoot) : value.projectRoot !== undefined) return undefined
  if (typeof value.tool !== 'string' || !['write', 'edit', 'bash'].includes(value.tool) || !isRecord(value.arguments)) return undefined
  const args = value.arguments
  if (typeof args.sandbox_permissions !== 'string' || !['workspace-write', 'danger-full-access'].includes(args.sandbox_permissions)) return undefined
  if (value.tool === 'bash') {
    if (value.path !== undefined || typeof args.command !== 'string' || !args.command.trim() || !absolute(args.workdir)) return undefined
  } else {
    if (!absolute(args.file_path) || !absolute(value.path) || value.path !== args.file_path) return undefined
  }
  if (value.maxUses !== undefined && (!Number.isSafeInteger(value.maxUses) || Number(value.maxUses) < 0)) return undefined
  if (value.used !== undefined && (!Number.isSafeInteger(value.used) || Number(value.used) < 0)) return undefined
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return undefined
  if (value.note !== undefined && typeof value.note !== 'string') return undefined
  return structuredClone(value) as unknown as Grant
}
function parseFile(text: string): GrantsFile {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.rules) || Object.keys(raw).some(key => !['version', 'rules'].includes(key))) throw new Error('invalid grants file')
  const rules = raw.rules.map(normalizeGrant)
  if (rules.some(rule => !rule) || new Set(rules.map(rule => rule?.id)).size !== rules.length) throw new Error('invalid or duplicate grant')
  return { version: 1, rules: rules as Grant[] }
}
export function readGrantsFile(file: string): GrantsFile { return parseFile(readFileSync(file, 'utf8')) }
export function writeGrantsFile(file: string, rules: readonly Grant[]): void {
  const text = JSON.stringify({ version: 1, rules }, null, 2) + '\n'
  parseFile(text)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = resolve(dirname(file), `.grants-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
export function projectMatches(grant: Grant, projectRoot: string | undefined): boolean {
  return grant.scope === 'permanent' || absolute(projectRoot) && normalize(projectRoot) === normalize(grant.projectRoot!)
}
export function grantMatches(grant: Grant, tool: string, args: unknown, projectRoot: string | undefined, now: number): boolean {
  return grant.tool === tool && projectMatches(grant, projectRoot)
    && (grant.expiresAt === undefined || now < Date.parse(grant.expiresAt))
    && (!grant.maxUses || (grant.used ?? 0) < grant.maxUses)
    && matchesSubset(grant.arguments, args)
}
/** Missing profile identity disables durable grants; never guess from cwd/env. */
export function defaultGrantsFile(profileDir?: string, configured?: string): string | undefined {
  if (!absolute(profileDir)) return undefined
  const file = resolve(profileDir, configured ?? 'approval-allowlist/grants.json')
  const suffix = relative(resolve(profileDir), file)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('grantsFile must stay inside the profile')
  return file
}
/** Each decision re-reads disk. Bad JSON retains lastGood for diagnostics only, never authority. */
export class GrantStore {
  lastGood: Grant[] = []
  constructor(readonly file: string, readonly profileDir?: string) {}
  private checkLocation(): void {
    if (this.profileDir && !inside(canonical(this.profileDir), canonical(this.file))) throw new Error('grants file escapes profile through a symlink')
  }
  private protectedTarget(rule: Grant): boolean {
    if (!rule.path) return false
    const target = canonical(rule.path)
    return this.profileDir ? inside(canonical(this.profileDir), target) : target === canonical(this.file)
  }
  read(): Grant[] {
    this.checkLocation()
    try { this.lastGood = readGrantsFile(this.file).rules; return structuredClone(this.lastGood) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.lastGood = []; return [] } throw error }
  }
  transaction<T>(body: (rules: Grant[]) => { value: T; save: boolean }): T {
    this.checkLocation()
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`
    const fd = openSync(lock, 'wx', 0o600)
    try {
      const rules = this.read()
      const result = body(rules)
      if (result.save) writeGrantsFile(this.file, rules)
      this.lastGood = rules
      return result.value
    } finally { closeSync(fd); rmSync(lock, { force: true }) }
  }
  match(tool: string, args: unknown, projectRoot: string | undefined, consume: boolean): Grant | undefined {
    const matches = (rule: Grant) => grantMatches(rule, tool, args, projectRoot, Date.now()) && !this.protectedTarget(rule)
    const candidate = this.read().find(matches)
    if (!consume || !candidate) return candidate
    return this.transaction(rules => {
      const rule = rules.find(matches)
      if (rule?.maxUses) rule.used = (rule.used ?? 0) + 1
      return { value: rule, save: Boolean(rule?.maxUses) }
    })
  }
}
