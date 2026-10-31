import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { safeConfigPath } from './config-transaction.js'
import { assertSeparatePaths } from './development.js'
import type { CommandContext } from './command-context.js'

/** Reject aliases (including dangling links) before creating or deleting data. */
export function freshTestHome(root: string, runDir: string, requested?: string): string {
  const home = resolve(root, requested || join(runDir, 'dsh-home'))
  try { safeConfigPath(join(root, '.tmp'), home) }
  catch { throw new Error('--home must be a new directory inside the workspace .tmp without links') }
  if (home === resolve(root, '.tmp') || existsSync(home)) throw new Error('--home must be a new directory inside the workspace .tmp (existing profiles are never reused)')
  return home
}

export function validateTestRoot(settings: CommandContext, path: string): void {
  safeConfigPath(join(settings.root, '.tmp'), path)
  assertSeparatePaths(path, join(settings.root, '.local/dsh-dev'))
  for (const target of settings.config.targets) assertSeparatePaths(path, target.home)
}

/** Explicit npm/pnpm sources, while preserving OS identity for Chrome/keychain.
 * No HOME/USERPROFILE rewrite: these are not package-manager config selectors.
 */
export function packageEnvironment(parent: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const key of Object.keys(env)) {
    if (/^(npm_config_|pnpm_|corepack_)/i.test(key) || /^(XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/i.test(key)) delete env[key]
  }
  return Object.assign(env, {
    npm_config_userconfig: join(directory, 'npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_cache: join(directory, 'cache'), npm_config_store_dir: join(directory, 'pnpm-store'),
    pnpm_config_store_dir: join(directory, 'pnpm-store'), PNPM_HOME: join(directory, 'pnpm-home'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'),
  })
}

export function preparePackageEnvironment(directory: string): void {
  for (const name of ['config', 'cache', 'data', 'pnpm-home']) mkdirSync(join(directory, name), { recursive: true })
  for (const name of ['npmrc', 'global.npmrc']) if (!existsSync(join(directory, name))) writeFileSync(join(directory, name), '', { flag: 'wx' })
}

/** lstat each entry: a profile's link dependencies are unlinked, never traversed. */
export function removeTestData(root: string, path: string): void {
  safeConfigPath(join(root, '.tmp'), dirname(path))
  if (!existsSync(path)) {
    try { lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(path)
  else { for (const name of readdirSync(path)) removeTestData(root, join(path, name)); rmdirSync(path) }
}
