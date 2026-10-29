import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repository root, derived from this module's location. The test project
 * compiles `test/src` to `test/.build` with the same depth, so `../../../`
 * points at the repository in both source and compiled form.
 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Create a temporary directory inside the workspace.
 *
 * `.tmp/` is gitignored and writable under DSH's workspace-write sandbox; the
 * system temp directory is not guaranteed to be writable there.
 */
export function makeTempDir(prefix: string): string {
  const base = join(repoRoot, '.tmp', 'test')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `${prefix}-`))
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}
