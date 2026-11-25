import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { safeConfigPath } from './config-transaction.js'
import { errorMessage, isRecord } from './json.js'
import { hasUnstoppedOwnedProcesses, sleep } from './exec.js'

export const FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const stateFile = 'cleanup-state.json'
const fixtureName = /^repo 中文 space-[\w-]+$/
const fixtureData = ['node_modules', 'checkout/node_modules', 'store', 'cache', 'home', '.formal-home', '.formal-host', '.local/dsh-dev/home',
  '.shared-package/pnpm-store', '.shared-package/cache', '.shared-package/state', '.shared-package/data', '.shared-package/pnpm-home']
let handledInterruptions = 0
export const handledTestInterruptionCount = () => handledInterruptions
export const noteTestInterruption = () => { handledInterruptions++ }

interface CleanupState {
  version: 1; root: string; run: string; started: string; ended: string | null
  status: 'passed' | 'failed'; complete: boolean; keep: boolean; paths: string[]
}
export interface CleanupItem { path: string; action: 'remove' | 'retain' | 'skip'; reason: string; removed?: boolean }
export interface CleanupResult { status: 'preview' | 'passed' | 'failed' | 'skipped'; items: CleanupItem[]; error?: string }

function writeState(root: string, run: string, state: CleanupState): void {
  const path = join(run, stateFile), temporary = join(run, `.cleanup-${randomUUID()}.json`)
  safeConfigPath(root, path); safeConfigPath(root, temporary)
  try { writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function readState(root: string, run: string): CleanupState {
  safeConfigPath(root, join(run, stateFile))
  const value: unknown = JSON.parse(readFileSync(join(run, stateFile), 'utf8'))
  if (!isRecord(value) || value.version !== 1 || value.root !== root || value.run !== basename(run)
    || typeof value.started !== 'string' || !Number.isFinite(Date.parse(value.started))
    || (value.ended !== null && (typeof value.ended !== 'string' || !Number.isFinite(Date.parse(value.ended))))
    || !['passed', 'failed'].includes(String(value.status)) || typeof value.complete !== 'boolean' || typeof value.keep !== 'boolean'
    || !Array.isArray(value.paths) || value.paths.some(path => typeof path !== 'string' || !allowedData(path))
    || new Set(value.paths).size !== value.paths.length) throw new Error('missing or invalid cleanup record')
  return value as unknown as CleanupState
}

function allowedData(path: string): boolean {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return false
  if (/^shared-host-install-[\w-]+$/.test(path)) return true
  const [fixture, ...parts] = path.split('/'), rest = parts.join('/')
  return !!fixture && fixtureName.test(fixture) && (fixtureData.includes(rest)
    || /^\.tmp\/(l4|l5|iso)\/run-[\w-]+\/(dsh-home|dsh-home-tarball|bin|workspace)$/.test(rest))
}

function dataPaths(run: string): string[] {
  const paths: string[] = []
  for (const name of readdirSync(run)) {
    if (/^shared-host-install-[\w-]+$/.test(name)) paths.push(name)
    if (!fixtureName.test(name) || !lstatSync(join(run, name)).isDirectory() || lstatSync(join(run, name)).isSymbolicLink()) continue
    paths.push(...fixtureData.map(path => `${name}/${path}`))
    for (const kind of ['l4', 'l5', 'iso']) {
      const base = join(run, name, '.tmp', kind)
      try {
        safeConfigPath(run, base)
        if (lstatSync(base).isSymbolicLink()) continue
        for (const nested of readdirSync(base).filter(value => /^run-[\w-]+$/.test(value))) {
          paths.push(...['dsh-home', 'dsh-home-tarball', 'bin', 'workspace'].map(path => `${name}/.tmp/${kind}/${nested}/${path}`))
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  return paths.filter(path => {
    safeConfigPath(run, dirname(join(run, path)))
    try { lstatSync(join(run, path)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  })
}

export function startEnvironmentCleanup(root: string, run: string, keep: boolean): void {
  root = realpathSync(root); safeConfigPath(join(root, '.tmp/environment-tests'), run)
  writeState(root, run, { version: 1, root, run: basename(run), started: new Date().toISOString(), ended: null, status: 'failed', complete: false, keep, paths: [] })
}

export function finishEnvironmentCleanup(root: string, run: string, status: 'passed' | 'failed', complete: boolean): void {
  root = realpathSync(root)
  const state = readState(root, run)
  writeState(root, run, { ...state, ended: new Date().toISOString(), status, complete: complete && !hasUnstoppedOwnedProcesses(), paths: dataPaths(run) })
}

/** Rare explicit consumers keep their containing historical run, without a reference graph. */
function consumerPaths(root: string, paths: readonly (string | undefined)[]): string[] {
  const result: string[] = []
  for (const path of paths) {
    if (!path) continue
    const lexical = resolve(root, path)
    result.push(lexical)
    let ancestor = lexical
    for (;;) {
      try { result.push(resolve(realpathSync(ancestor), relative(ancestor, lexical))); break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  return [...new Set(result)]
}

export function keepEnvironmentPaths(root: string, paths: readonly (string | undefined)[]): void {
  root = realpathSync(root)
  const base = join(root, '.tmp/environment-tests')
  for (const path of consumerPaths(root, paths)) {
    const rel = relative(base, path), name = rel.split(sep)[0]
    if (!name || !/^run-[\w-]+$/.test(name) || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const run = join(base, name)
    let state: CleanupState
    try { state = readState(root, run) }
    catch { console.log(`test cleanup: historical data stays protected (no valid cleanup record): ${run}`); continue }
    if (!state.keep) { writeState(root, run, { ...state, keep: true }); console.log(`test cleanup: keep explicit consumer data in ${run}`) }
  }
}

export function usesEnvironmentPaths(root: string, paths: readonly (string | undefined)[]): boolean {
  const base = join(realpathSync(root), '.tmp/environment-tests')
  return consumerPaths(root, paths).some(path => /^run-[\w-]+(?:[\\/]|$)/.test(relative(base, path)))
}

/** One command-level lock. Cleanup never waits; commands may wait for cleanup. */
export async function withTestWorkLock<T>(root: string, kind: 'test' | 'cleanup', body: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  root = realpathSync(root)
  const path = join(root, '.tmp/test-work.lock')
  safeConfigPath(root, path); mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify({ version: 1, root, kind, pid: process.pid, token: randomUUID() })
  const abort = new AbortController()
  const interrupted = () => abort.abort(new Error('interrupted while waiting for test/cleanup lock'))
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted)
  const temporary = join(dirname(path), `.test-work-${randomUUID()}.lock`)
  safeConfigPath(root, temporary)
  let created = false
  try {
    const fd = openSync(temporary, 'wx'); created = true
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    for (;;) {
      signal?.throwIfAborted(); abort.signal.throwIfAborted()
      try {
        linkSync(temporary, path); break // Publish only complete bytes, atomically and exclusively.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (kind === 'cleanup') return undefined
        let owner: unknown
        try { safeConfigPath(root, path); owner = JSON.parse(readFileSync(path, 'utf8')) }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw readError }
        if (!isRecord(owner) || owner.kind !== 'cleanup') throw new Error(`test command locked: ${path}; verify the owner and children before removing a stale lock`)
        await sleep(100)
      }
    }
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted)
    if (created) unlinkSync(temporary)
  }
  try { return await body() }
  finally {
    if (hasUnstoppedOwnedProcesses()) throw new Error(`owned process exit unconfirmed; lock retained: ${path}`)
    safeConfigPath(root, path)
    if (readFileSync(path, 'utf8') !== bytes) throw new Error('test/cleanup lock ownership changed')
    unlinkSync(path)
  }
}

/** Diagnose conservatively: package assets are not screenshots; command evidence is. */
function hasEvidence(path: string, dependency: boolean): boolean {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return false // Only unlink this entry, never traverse its target.
  if (stat.isDirectory()) return readdirSync(path).some(name =>
    (!dependency && ['logs', 'artifacts', 'screenshots', 'traces', 'dist'].includes(name)) || hasEvidence(join(path, name), dependency))
  return /^(report|results|manifest|.*-details|.*\.report)\.json$|\.(jsonl|log|out|err|tgz)$|^trace\.zip$/i.test(basename(path))
    || (!dependency && /\.(png|jpe?g|webp|zip)$/i.test(path))
}

export async function cleanupEnvironmentTests(root: string, apply: boolean, now = Date.now()): Promise<CleanupResult> {
  root = realpathSync(root)
  const result = await withTestWorkLock(root, 'cleanup', async (): Promise<CleanupResult> => {
    const items: CleanupItem[] = []
    const report: CleanupResult = { status: apply ? 'passed' : 'preview', items }
    try {
      const base = join(root, '.tmp/environment-tests'); safeConfigPath(root, base)
      if (existsSync(base)) for (const name of readdirSync(base).filter(value => /^run-[\w-]+$/.test(value)).sort()) {
        const run = join(base, name)
        let state: CleanupState
        try { state = readState(root, run) }
        catch { items.push({ path: run, action: 'skip', reason: 'legacy or invalid record; verify separately' }); continue }
        const age = state.ended === null ? -1 : now - Date.parse(state.ended)
        const reason = state.keep ? 'keep' : !state.complete || age < 0 || Date.parse(state.ended!) < Date.parse(state.started)
          ? 'unfinished or exit unconfirmed' : state.status === 'failed' && age < FAILURE_RETENTION_MS ? 'failure retained for seven days' : ''
        if (reason) { items.push({ path: run, action: 'retain', reason }); continue }
        for (const candidate of state.paths) {
          const path = join(run, candidate)
          // Ancestors must stay ordinary directories. The leaf may be an owned link.
          safeConfigPath(root, dirname(path))
          let exists = true
          try { lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error }
          if (!exists) { items.push({ path, action: 'skip', reason: 'already absent' }); continue }
          if (hasEvidence(path, candidate.endsWith('/node_modules'))) { items.push({ path, action: 'retain', reason: 'contains diagnostic or artifact evidence' }); continue }
          const item: CleanupItem = { path, action: 'remove', reason: state.status === 'passed' ? 'completed success data' : 'failure ended at least seven days ago' }
          items.push(item)
          if (apply) { rmSync(path, { recursive: true, force: true }); item.removed = true }
        }
      }
    } catch (error) { report.status = 'failed'; report.error = errorMessage(error) }
    if (apply) {
      const path = join(root, '.tmp/environment-tests/last-cleanup.json'); safeConfigPath(root, path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ ...report, ended: new Date().toISOString() }, null, 2))
    }
    return report
  })
  return result ?? { status: 'skipped', items: [], error: 'test/cleanup command is running or its lock needs verification' }
}
