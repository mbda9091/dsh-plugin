import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CommandContext } from './command-context.js'
import { commandEnv, configuredDsh, configuredPnpm } from './command-context.js'
import { safeConfigPath } from './config-transaction.js'
import { isRecord } from './json.js'
import { runToFiles } from './exec.js'
import { writePnpmShim } from './pnpm.js'
import { delimiter } from 'node:path'
import { renderWebPatch } from './web-patch.js'

export function developmentPaths(root: string) {
  const directory = resolve(root, '.local/dsh-dev')
  return { directory, home: join(directory, 'home'), profile: join(directory, 'home/profiles/web'),
    store: join(directory, 'store'), logs: join(directory, 'logs'), bin: join(directory, 'bin'),
    patch: join(directory, 'cordis.patch.yml'), owner: join(directory, 'owner.json'),
    runtime: join(directory, 'runtime.json'), lock: resolve(root, '.local/dsh-dev.lock') }
}

/** Resolve missing paths through their nearest existing ancestor, including aliases. */
export function physicalPath(path: string): string {
  if (!isAbsolute(path)) throw new Error('environment path must be absolute')
  let ancestor = resolve(path)
  for (;;) {
    try { lstatSync(ancestor); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Probe an existing ancestor without writes. macOS volumes may be either case
 * sensitive or insensitive; missing suffixes must obey that volume's rules. */
function comparisonPath(path: string): string {
  const actual = physicalPath(path)
  let ancestor = resolve(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  for (;;) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return actual
    const name = relative(parent, ancestor)
    const alternate = name.replace(/[a-zA-Z]/, char => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())
    if (alternate !== name) {
      try { return realpathSync(join(parent, alternate)) === realpathSync(ancestor) ? actual.toLowerCase() : actual }
      catch { return actual }
    }
    ancestor = parent
  }
}

export function assertSeparatePaths(a: string, b: string): void {
  const left = comparisonPath(a), right = comparisonPath(b)
  if (within(left, right) || within(right, left)) throw new Error(`environment paths overlap: ${a} / ${b}`)
}

export function validateDevelopmentPaths(context: CommandContext): void {
  const p = developmentPaths(context.root)
  for (const path of Object.values(p)) safeConfigPath(context.root, path)
  assertSeparatePaths(p.directory, resolve(context.root, '.tmp'))
  for (const target of [...context.config.targets, ...(context.target ? [context.target] : [])]) {
    assertSeparatePaths(p.directory, target.home)
    assertSeparatePaths(resolve(context.root, '.tmp'), target.home)
  }
}

interface Owner {
  version: 1
  purpose: 'dsh-development'
  root: string
  id: string
  initialized: boolean
  links: Record<string, string>
}

export function readDevelopmentOwner(context: CommandContext): Owner {
  validateDevelopmentPaths(context)
  const p = developmentPaths(context.root)
  if (!existsSync(p.owner)) throw new Error('development ownership is missing; run web init for a new environment; never adopt existing data')
  const value: unknown = JSON.parse(readFileSync(p.owner, 'utf8'))
  if (!isRecord(value) || value.version !== 1 || value.purpose !== 'dsh-development' || value.root !== realpathSync(context.root)
    || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.initialized !== 'boolean'
    || !isRecord(value.links) || !Object.values(value.links).every(v => typeof v === 'string')) throw new Error('development ownership does not match this repository')
  return value as unknown as Owner
}

export function acquireDevelopmentLock(context: CommandContext): () => void {
  validateDevelopmentPaths(context)
  const p = developmentPaths(context.root)
  mkdirSync(dirname(p.lock), { recursive: true })
  try { writeFileSync(p.lock, JSON.stringify({ pid: process.pid, id: randomUUID() }), { flag: 'wx' }) }
  catch { throw new Error(`development operation locked: ${p.lock}; verify the owner has exited before manual recovery`) }
  return () => { safeConfigPath(context.root, p.lock); unlinkSync(p.lock) }
}

export function developmentEnvironment(context: CommandContext): NodeJS.ProcessEnv {
  const p = developmentPaths(context.root)
  const env = { ...commandEnv(context) }
  // Explicit config files prevent personal npm/pnpm configuration redirecting writes.
  for (const key of Object.keys(env)) if (/^(npm_config_|pnpm_config_)/i.test(key)) delete env[key]
  Object.assign(env, { npm_config_userconfig: join(p.directory, 'npmrc'), npm_config_globalconfig: join(p.directory, 'global.npmrc'),
    pnpm_config_store_dir: p.store, npm_config_store_dir: p.store, npm_config_cache: join(p.directory, 'cache') })
  env.PATH = `${p.bin}${delimiter}${env.PATH ?? ''}`
  return env
}

/** Caller holds the operation lock. A partial init may be retried, but never adopted. */
export function initializeDevelopment(context: CommandContext): Owner {
  validateDevelopmentPaths(context)
  const p = developmentPaths(context.root)
  const runner = configuredDsh(context, true), pnpm = configuredPnpm(context)
  let owner: Owner
  if (existsSync(p.directory)) owner = readDevelopmentOwner(context)
  else {
    mkdirSync(p.directory)
    owner = { version: 1, purpose: 'dsh-development', root: realpathSync(context.root), id: randomUUID(), initialized: false, links: {} }
    writeFileSync(p.owner, JSON.stringify(owner, null, 2), { flag: 'wx' })
  }
  validateDevelopmentTree(context)
  if (owner.initialized) return owner
  if (existsSync(p.runtime)) throw new Error('development instance exists; stop it before initialization')
  for (const dir of [p.home, p.store, p.logs, p.bin]) mkdirSync(dir, { recursive: true })
  for (const name of ['npmrc', 'global.npmrc']) {
    const file = join(p.directory, name)
    if (!existsSync(file)) writeFileSync(file, '', { flag: 'wx' })
  }
  if (!existsSync(p.patch)) writeFileSync(p.patch, renderWebPatch(readFileSync(join(context.root, 'profiles/web/cordis.dev.patch.yml'), 'utf8'), context.root), { flag: 'wx' })
  writePnpmShim(p.bin, pnpm)
  const result = runToFiles(runner.command, runner.build(['--profile', 'web', '--dump-config']), {
    cwd: context.root, env: developmentEnvironment(context), timeoutMs: context.config.web.startupTimeoutMs,
    stdoutPath: join(p.logs, 'init.out.log'), stderrPath: join(p.logs, 'init.err.log'),
  })
  if (result.status !== 0 || !result.stdout.includes('@deepseek-ai/dsh-web-app')) throw new Error(`development profile initialization failed; inspect ${p.logs}; retry web init`)
  owner.initialized = true
  validateDevelopmentPaths(context)
  writeFileSync(p.owner, JSON.stringify(owner, null, 2))
  return owner
}

/** Register intent before install so a partially installed, known link is recoverable. */
export function recordDevelopmentLinks(context: CommandContext, plugins: readonly { packageName: string; dir: string }[]): void {
  const owner = readDevelopmentOwner(context), p = developmentPaths(context.root)
  for (const plugin of plugins) {
    safeConfigPath(context.root, plugin.dir)
    owner.links[relative(p.directory, join(p.profile, 'node_modules', plugin.packageName))] = realpathSync(plugin.dir)
  }
  writeFileSync(p.owner, JSON.stringify(owner, null, 2))
}

export function verifyDevelopmentLinks(context: CommandContext, plugins: readonly { packageName: string; dir: string }[]): void {
  const p = developmentPaths(context.root)
  const manifest = JSON.parse(readFileSync(join(p.profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const plugin of plugins) {
    const installed = join(p.profile, 'node_modules', plugin.packageName)
    const spec = manifest.dependencies?.[plugin.packageName]
    if (!spec?.startsWith('link:') || realpathSync(resolve(p.profile, spec.slice(5))) !== realpathSync(plugin.dir)
      || !lstatSync(installed).isSymbolicLink() || realpathSync(installed) !== realpathSync(plugin.dir)) throw new Error(`development link verification failed: ${plugin.packageName}`)
  }
}

/** Inventory first, then delete with lstat per entry: never recurse through a link. */
export function validateDevelopmentTree(context: CommandContext): void {
  const p = developmentPaths(context.root), owner = readDevelopmentOwner(context)
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const target = physicalPath(path)
      const expected = owner.links[relative(p.directory, path)]
      if (!within(p.directory, target) && (expected === undefined || target !== expected || !within(realpathSync(context.root), expected))) {
        throw new Error(`unknown external development link: ${path}`)
      }
    } else if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
  }
  visit(p.directory)
}

export function removeDevelopment(context: CommandContext): void {
  validateDevelopmentTree(context)
  const p = developmentPaths(context.root)
  if (existsSync(p.runtime)) throw new Error('development process identity is unresolved; stop it before reset')
  const remove = (path: string): void => {
    // Check parents again; unlink the leaf itself without resolving its destination.
    safeConfigPath(context.root, dirname(path))
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(path)
    else { for (const child of readdirSync(path)) remove(join(path, child)); rmdirSync(path) }
  }
  remove(p.directory)
}
