import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function maintenancePaths(root: string) {
  const directory = join(root, 'scripts/config')
  return { directory, lock: join(directory, '.local-maintenance.lock'), pending: join(directory, '.local-maintenance.pending.json'), state: join(directory, '.local-maintenance.json'), backups: join(directory, '.local-backups') }
}

/** Reject links at every component, including dangling links and ancestors. */
export function safeConfigPath(root: string, path: string): void {
  const inside = relative(resolve(root), resolve(path))
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || resolve(root, inside) !== resolve(path)) throw new Error('configuration path escapes repository')
  let current = resolve(path)
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`configuration path is a link: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function assertConfigReady(root: string): void {
  const paths = maintenancePaths(root)
  for (const path of [paths.directory, paths.lock, paths.pending, join(paths.directory, 'local.json')]) safeConfigPath(root, path)
  if (existsSync(paths.pending) || existsSync(paths.lock)) {
    throw new Error(`configuration maintenance pending/locked; stop the owner process before recovery. Inspect ${paths.pending} and backup manifest; restore only matching hashes, mark rolled-back, then remove pending/lock. See docs/configuration-v2.md`)
  }
}

export interface ConfigChange { name: 'local.json' | '.local-maintenance.json'; before: Buffer | null; after: Buffer }
export interface TransactionPlan { changes: ConfigChange[]; inputs: { path: string; hash: string }[]; backup: string }
export type TransactionPoint = 'locked' | 'backup' | 'candidate' | 'pending' | 'replace' | 'verify' | 'rollback'
/** Test-only injection boundary; not exposed through CLI or environment. */
export interface TransactionHooks { at?: (point: TransactionPoint, index: number) => void }

export function commitConfig(root: string, plan: TransactionPlan, hooks: TransactionHooks = {}): void {
  const paths = maintenancePaths(root)
  assertConfigReady(root)
  for (const path of [paths.state, paths.backups, plan.backup]) safeConfigPath(root, path)
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, id: randomUUID() }), { flag: 'wx' })
  const candidates: string[] = []
  let pending = false
  let preserve = false
  const currentHash = (path: string): string | null => existsSync(path) ? digest(readFileSync(path)) : null
  const verifyInputs = () => {
    for (const input of plan.inputs) {
      safeConfigPath(root, input.path)
      if (currentHash(input.path) !== input.hash) throw new Error('migration input changed; preview again')
    }
  }
  const checkBefore = (change: ConfigChange) => {
    const path = join(paths.directory, change.name)
    safeConfigPath(root, path)
    if (currentHash(path) !== (change.before === null ? null : digest(change.before))) throw new Error(`concurrent edit: ${change.name}`)
  }
  const manifest = { version: 1, migration: 'v1-v2', status: 'prepared', files: plan.changes.map(c => ({ name: c.name, before: c.before === null ? null : digest(c.before), after: digest(c.after) })) }
  const manifestPath = join(plan.backup, 'manifest.json')
  const saveManifest = () => { safeConfigPath(root, manifestPath); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)) }
  try {
    hooks.at?.('locked', 0)
    verifyInputs()
    plan.changes.forEach(checkBefore)
    mkdirSync(plan.backup, { recursive: true })
    plan.changes.forEach((change, index) => {
      hooks.at?.('backup', index)
      const backup = join(plan.backup, change.name)
      safeConfigPath(root, backup)
      if (change.before !== null) {
        writeFileSync(backup, change.before, { flag: 'wx' })
        if (digest(readFileSync(backup)) !== digest(change.before)) throw new Error('backup verification failed')
      }
    })
    saveManifest()
    plan.changes.forEach((change, index) => {
      hooks.at?.('candidate', index)
      const candidate = join(paths.directory, `.local-candidate-${randomUUID()}.json`)
      safeConfigPath(root, candidate)
      writeFileSync(candidate, change.after, { flag: 'wx' })
      candidates.push(candidate)
      if (digest(readFileSync(candidate)) !== digest(change.after)) throw new Error('candidate verification failed')
    })
    verifyInputs()
    plan.changes.forEach(checkBefore)
    safeConfigPath(root, paths.pending)
    writeFileSync(paths.pending, JSON.stringify({ version: 1, backup: relative(root, plan.backup), manifest, candidates: candidates.map(p => relative(root, p)) }, null, 2), { flag: 'wx' })
    pending = true
    hooks.at?.('pending', 0)
    plan.changes.forEach((change, index) => {
      hooks.at?.('replace', index)
      checkBefore(change)
      safeConfigPath(root, candidates[index]!)
      renameSync(candidates[index]!, join(paths.directory, change.name))
      hooks.at?.('verify', index)
      if (currentHash(join(paths.directory, change.name)) !== digest(change.after)) throw new Error(`verification failed: ${change.name}`)
    })
    for (const change of plan.changes) {
      const path = join(paths.directory, change.name)
      safeConfigPath(root, path)
      if (currentHash(path) !== digest(change.after)) throw new Error(`final verification failed: ${change.name}`)
    }
    manifest.status = 'committed'
    saveManifest()
  } catch (error) {
    if (pending) {
      for (const [index, change] of plan.changes.entries()) {
        try {
          const path = join(paths.directory, change.name)
          safeConfigPath(root, path)
          const hash = currentHash(path)
          if (hash === (change.before === null ? null : digest(change.before))) continue
          if (hash !== digest(change.after)) throw new Error('third-party content; manual recovery required')
          hooks.at?.('rollback', index)
          if (change.before === null) unlinkSync(path)
          else {
            const restore = join(paths.directory, `.local-candidate-${randomUUID()}.json`)
            candidates.push(restore)
            safeConfigPath(root, restore)
            writeFileSync(restore, change.before, { flag: 'wx' })
            renameSync(restore, path)
          }
        } catch { preserve = true }
      }
      if (!preserve) { manifest.status = 'rolled-back'; try { saveManifest() } catch { preserve = true } }
    }
    if (preserve) throw new Error(`migration interrupted; manual recovery required: ${paths.pending}`, { cause: error })
    throw error
  } finally {
    if (!preserve) {
      for (const candidate of candidates) { safeConfigPath(root, candidate); if (existsSync(candidate)) unlinkSync(candidate) }
      if (pending) { safeConfigPath(root, paths.pending); unlinkSync(paths.pending) }
      safeConfigPath(root, paths.lock)
      unlinkSync(paths.lock)
    }
  }
}
