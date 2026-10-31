import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
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
