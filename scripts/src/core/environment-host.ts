import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { digest, safeConfigPath } from './config-transaction.js'
import { isRecord } from './json.js'
import { runToFilesAsync } from './exec.js'
import { checkNode, checkPnpm } from './toolchain.js'
import { OwnedProcesses } from './owned-processes.js'
import { pnpmInstallConfig } from './pnpm-install-config.js'

export const sharedHostCases = ['TGT-04', 'TGT-05-real', 'TGT-06-real'] as const
// Node exposes POSIX process groups, but no Windows Job Object containment.
export const supportsSharedEnvironmentHost = (platform: NodeJS.Platform = process.platform) => platform !== 'win32'

export interface EnvironmentHostEvidence {
  version: 1
  run: string
  host: string
  entry: string
  fingerprint: string
  configFingerprint: string
  mode: 'preparing' | 'prepared' | 'reused'
  reason: string
  installCount: number
  users: Array<{ id: string; home: string }>
  status: 'using' | 'passed' | 'failed'
  unchanged: boolean
  released: boolean
  processGroupsStopped: boolean
  isolatedInstallation: boolean
  error?: string
}

export interface EnvironmentHostLease {
  evidence: EnvironmentHostEvidence
  verify(): void
  close(): Promise<void>
}

export class EnvironmentHostError extends Error {
  constructor(readonly evidence: EnvironmentHostEvidence, cause: unknown) {
    super(evidence.error, { cause })
  }
}

/** A node:test timeout does not settle its async body. Keep actual work serialized. */
export function environmentHostCases() {
  let tail = Promise.resolve(), draining = false
  return {
    run(body: () => Promise<void>): Promise<void> {
      if (draining) return Promise.reject(new Error('shared host case group already draining'))
      const work = tail.then(body)
      tail = work.catch(() => {})
      return work
    },
    async drain(): Promise<void> { draining = true; await tail },
  }
}

/** Remove only our exclusively-created file if initialization fails (e.g. ENOSPC). */
function writeExclusive(path: string, bytes: string): void {
  const fd = openSync(path, 'wx')
  const errors: unknown[] = []
  try { writeFileSync(fd, bytes) }
  catch (error) { errors.push(error) }
  try { closeSync(fd) } catch (error) { errors.push(error) }
  if (errors.length) {
    try { unlinkSync(path) } catch (error) { errors.push(error) }
    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
  }
}

function absent(path: string): boolean {
  try { lstatSync(path); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}

/** Content and mode, not timestamps. Links are recorded, never traversed. */
function treeHash(root: string): string {
  const hash = createHash('sha256')
  function visit(path: string, key: string): void {
    const stat = lstatSync(path)
    hash.update(JSON.stringify([key, stat.mode]))
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path))
    else if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${key}/${name}`)
    else if (stat.isFile()) hash.update(digest(readFileSync(path)))
    else throw new Error(`unsupported shared host file: ${path}`)
  }
  visit(root, '.')
  return hash.digest('hex')
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Never publish links or generated runtime files that still depend on the installer. */
function assertPublishable(root: string, path = root, forbidden = root): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    if (isAbsolute(readlinkSync(path)) || !inside(root, realpathSync(path))) throw new Error('shared host installation has a nonportable link')
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertPublishable(root, join(path, name), forbidden)
  } else if (stat.isFile() && readFileSync(path).includes(Buffer.from(forbidden))) {
    throw new Error('shared host runtime file references its temporary installation directory')
  }
}

function copyHost(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
  // cpSync preserves file modes, but creates directories with the default mode.
  const modes = (from: string, to: string): void => {
    const stat = lstatSync(from)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    for (const name of readdirSync(from)) modes(join(from, name), join(to, name))
    chmodSync(to, stat.mode & 0o7777)
  }
  modes(source, destination)
}

/** Test infrastructure only. No target discovery, user profiles or private store. */
export async function acquireEnvironmentHost(options: {
  root: string; runDir: string; pnpmScript: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; processes?: OwnedProcesses
}): Promise<EnvironmentHostLease> {
  if (!supportsSharedEnvironmentHost()) throw new Error('shared environment hosts require POSIX process-group tracking; Windows uses independent fixtures')
  checkNode()
  const root = realpathSync(options.root), run = realpathSync(options.runDir)
  safeConfigPath(join(root, '.tmp'), run)
  const pnpm = checkPnpm(options.pnpmScript, root)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version: string = manifest.devDependencies?.['@deepseek-ai/dsh']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('shared host requires an exact root DSH version')
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const inputs = {
    format: 3, dsh: version, lock: digest(readFileSync(join(root, 'pnpm-lock.yaml'))), workspace: digest(workspace),
    node: realpathSync(process.execPath), nodeVersion: process.version, abi: process.versions.modules,
    pnpm, pnpmVersion: manifest.packageManager, pnpmEntry: digest(readFileSync(pnpm)), platform: process.platform, arch: process.arch,
  }
  const processes = options.processes ?? new OwnedProcesses()
  const directory = join(root, '.local/environment-tests'), host = join(directory, 'host')
  const owner = join(directory, 'owner.json'), ready = join(directory, 'ready.json'), lock = join(directory, 'host.lock')
  const evidence: EnvironmentHostEvidence = { version: 1, run, host, entry: '', fingerprint: digest(JSON.stringify(inputs)), configFingerprint: '', mode: 'preparing', reason: 'preparation not complete',
    installCount: 0, users: [], status: 'using', unchanged: false, released: false, processGroupsStopped: false, isolatedInstallation: false }
  const failure = (error: unknown) => {
    evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error)
    return new EnvironmentHostError(evidence, error)
  }
  for (const path of [directory, host, owner, ready, lock]) safeConfigPath(root, path)
  mkdirSync(directory, { recursive: true })
  const token = randomUUID(), lockBytes = JSON.stringify({ version: 1, pid: process.pid, token, run })
  try { writeExclusive(lock, lockBytes) }
  catch (error) {
    evidence.released = absent(lock)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failure(error)
    // A dead parent does not prove that all its child processes have exited.
    throw failure(new Error(`shared environment host locked: ${lock}; verify the owner and children before recovering a stale lock`))
  }
  const unlock = () => {
    safeConfigPath(root, lock)
    if (readFileSync(lock, 'utf8') !== lockBytes) throw new Error('shared host lock ownership changed')
    unlinkSync(lock)
  }
  const invalidate = () => {
    safeConfigPath(root, ready)
    if (readFileSync(lock, 'utf8') !== lockBytes) throw new Error('shared host lock ownership changed')
    if (existsSync(ready)) unlinkSync(ready)
  }
  try {
    if (existsSync(owner)) {
      const record: unknown = JSON.parse(readFileSync(owner, 'utf8'))
      if (!isRecord(record) || record.version !== 1 || record.purpose !== 'environment-test-host' || record.root !== root) throw new Error('shared host ownership mismatch')
    } else {
      if (readdirSync(directory).some(name => name !== 'host.lock')) throw new Error('shared host directory has unowned data')
      writeExclusive(owner, JSON.stringify({ version: 1, purpose: 'environment-test-host', root }))
    }
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CI: 'true' }
    for (const key of Object.keys(env)) if (/^(DSH_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key]
    // Even version probes must not discover the user's daily DSH home.
    env.DSH_HOME = join(run, 'shared-host-probe-home')
    const logs = join(run, 'shared-host'); mkdirSync(logs)
    let calls = 0
    const command = async (label: string, args: string[], cwd: string) => {
      const result = await processes.run(() => runToFilesAsync(process.execPath, args, { cwd, env, signal: options.signal, timeoutMs: label === 'install' ? 300_000 : 30_000,
        stdoutPath: join(logs, `${label}-${calls++}.out`), stderrPath: join(logs, `${label}-${calls - 1}.err`) }))
      if (result.status !== 0 || result.timedOut || result.signal) throw new Error(`shared host ${label} failed: ${result.stderr}\n${result.stdout}`)
      return result.stdout.trim()
    }
    const identify = (): string => {
      const pkgPath = join(host, 'node_modules/@deepseek-ai/dsh/package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== version) throw new Error('shared host DSH identity mismatch')
      const pkgRoot = realpathSync(dirname(pkgPath))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
      if (typeof bin !== 'string' || !inside(host, pkgRoot)) throw new Error('shared host DSH resolves outside owned host')
      const entry = realpathSync(resolve(pkgRoot, bin))
      if (!inside(pkgRoot, entry) || !lstatSync(entry).isFile()) throw new Error('shared host DSH entry escapes its package')
      const dev = join(root, 'node_modules/@deepseek-ai/dsh')
      if (existsSync(dev) && pkgRoot === realpathSync(dev)) throw new Error('shared host aliases workspace DSH')
      evidence.entry = entry
      return entry
    }
    const reset = () => {
      processes.assertIdle()
      invalidate(); safeConfigPath(root, host)
      rmSync(host, { recursive: true, force: true }); mkdirSync(host)
      writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': version } }))
      writeFileSync(join(host, 'pnpm-workspace.yaml'), workspace.replace(/packages:\r?\n(?:  .*\r?\n)+/, 'packages: []\n'))
    }
    const configHash = async (cwd: string) => processes.run(() => pnpmInstallConfig(pnpm, { cwd, env, signal: options.signal, timeoutMs: 30_000,
        stdoutPath: join(logs, `config-${calls++}.out`), stderrPath: join(logs, `config-${calls - 1}.err`) }))
    const configuration = async () => {
      evidence.configFingerprint = await configHash(host)
      evidence.fingerprint = digest(JSON.stringify({ ...inputs, config: evidence.configFingerprint }))
    }
    let reason = 'no successful preparation record', entry = '', baseline = '', reused = false
    let candidate: Record<string, unknown> | undefined
    if (existsSync(ready)) {
      try {
        const record: unknown = JSON.parse(readFileSync(ready, 'utf8'))
        if (!isRecord(record) || record.version !== 1) throw new Error('preparation record invalid')
        entry = identify()
        if (record.entry !== entry || record.tree !== treeHash(host)) throw new Error('shared host files changed')
        candidate = record
      } catch (error) {
        options.signal?.throwIfAborted()
        reason = error instanceof Error ? error.message : 'invalid shared host'
      }
    }
    if (!candidate) reset()
    await configuration()
    if (candidate) {
      try {
        if (candidate.fingerprint !== evidence.fingerprint) throw new Error('preparation inputs or effective installation configuration changed')
        if (await command('version', [entry, '--version'], run) !== version) throw new Error('shared host version mismatch')
        baseline = treeHash(host)
        if (candidate.tree !== baseline) throw new Error('shared host changed during configuration/version probes')
        reused = true; reason = 'preparation inputs, effective configuration, host files and version match'
      } catch (error) {
        options.signal?.throwIfAborted()
        processes.assertIdle()
        reason = error instanceof Error ? error.message : 'invalid shared host'
        reset()
        await configuration()
      }
    }
    if (!reused) {
      // An installer may daemonize outside its owned process group. Never let
      // it see the reusable destination: publish independent file copies only.
      const staging = mkdtempSync(join(run, 'shared-host-install-'))
      copyHost(host, staging)
      if (await configHash(staging) !== evidence.configFingerprint) throw new Error('temporary and shared host installation configuration differ')
      evidence.installCount++
      await command('install', [pnpm, 'install'], staging)
      processes.assertIdle()
      // pnpm's incremental-install state embeds the original cwd and is not
      // runtime input. The published host is never incrementally installed.
      rmSync(join(staging, 'node_modules/.pnpm-workspace-state-v1.json'), { force: true })
      assertPublishable(staging)
      const installed = treeHash(staging)
      rmSync(host, { recursive: true, force: true })
      copyHost(staging, host)
      if (treeHash(staging) !== installed || treeHash(host) !== installed) throw new Error('shared host installation changed while publishing')
      assertPublishable(host, host, staging)
      rmSync(staging, { recursive: true, force: true })
      entry = identify()
      if (!existsSync(join(host, 'pnpm-lock.yaml'))) throw new Error('shared host installation has no lockfile')
      if (await command('version', [entry, '--version'], run) !== version) throw new Error('shared host version mismatch')
      baseline = treeHash(host)
      writeFileSync(ready, JSON.stringify({ version: 1, fingerprint: evidence.fingerprint, entry, tree: baseline }))
    }
    evidence.isolatedInstallation = true
    evidence.mode = reused ? 'reused' : 'prepared'; evidence.reason = reason
    let closed = false
    const verify = () => {
      if (closed) throw new Error('shared host lease already closed')
      processes.assertIdle()
      safeConfigPath(root, host)
      if (readFileSync(lock, 'utf8') !== lockBytes) throw new Error('shared host lock ownership changed')
      if (treeHash(host) !== baseline) { invalidate(); throw new Error('test modified shared host; preparation invalidated') }
    }
    return { evidence, verify, async close() {
      if (closed) return
      const errors: unknown[] = []
      try { await processes.settle(); evidence.processGroupsStopped = true }
      catch (error) {
        closed = true
        try { invalidate() } catch { /* Preserve the lock even if invalidation also failed. */ }
        throw failure(error)
      }
      try { verify(); evidence.unchanged = true }
      catch (error) {
        errors.push(error)
        try { invalidate() } catch (invalidError) { errors.push(invalidError) }
      }
      closed = true
      try { unlock(); evidence.released = true } catch (error) { errors.push(error) }
      if (errors.length) throw failure(new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')))
      evidence.status = 'passed'
    } }
  } catch (error) {
    try { await processes.settle(); evidence.processGroupsStopped = true }
    catch (exitError) {
      try { invalidate() } catch { /* An unconfirmed tree must keep its lock. */ }
      throw failure(new AggregateError([error, exitError], 'shared host failed; process tree exit unconfirmed and lock retained'))
    }
    try { unlock(); evidence.released = true }
    catch (releaseError) { throw failure(new AggregateError([error, releaseError], 'shared host preparation and lock release failed')) }
    throw failure(error)
  }
}

export function assertEnvironmentHostEvidence(value: unknown, run: string, selected: string[]): asserts value is EnvironmentHostEvidence {
  const users = isRecord(value) && Array.isArray(value.users) ? value.users : []
  const expected = selected.filter(id => (sharedHostCases as readonly string[]).includes(id))
  if (!isRecord(value) || value.version !== 1 || value.run !== realpathSync(run) || value.status !== 'passed'
    || value.unchanged !== true || value.released !== true || value.processGroupsStopped !== true || value.isolatedInstallation !== true || typeof value.host !== 'string' || typeof value.entry !== 'string'
    || typeof value.fingerprint !== 'string' || !/^[a-f\d]{64}$/.test(value.fingerprint)
    || typeof value.configFingerprint !== 'string' || !/^[a-f\d]{64}$/.test(value.configFingerprint)
    || !['prepared', 'reused'].includes(String(value.mode)) || value.installCount !== (value.mode === 'prepared' ? 1 : 0)
    || users.length !== expected.length || expected.some(id => users.filter(user => isRecord(user) && user.id === id).length !== 1)
    || users.some(user => !isRecord(user) || typeof user.home !== 'string' || !inside(run, user.home))
    || new Set(users.map(user => isRecord(user) ? user.home : '')).size !== users.length) throw new Error('incomplete or failed shared host evidence')
}
