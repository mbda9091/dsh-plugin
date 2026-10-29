import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, readJson, stringArray } from './json.js'

/** A top-level bundle package: a directory whose package.json declares dsh.bundle. */
export interface Plugin {
  readonly dirName: string
  readonly dir: string
  readonly packageName: string
  readonly version: string
  readonly manifest: Record<string, unknown>
  readonly dsh: Record<string, unknown>
  readonly surfaces: string[]
  readonly platforms: string[]
}

const SKIP_DIRS = new Set(['node_modules', 'dist'])

/**
 * Discovers plugin packages the same way scripts/common.ps1 did: top-level
 * directories only, skipping dot-directories, node_modules and dist.
 */
export function discoverPlugins(repo: string): Plugin[] {
  const plugins: Plugin[] = []
  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue

    const dir = join(repo, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue

    const manifest = readJson(manifestPath)
    if (!isRecord(manifest)) continue

    const dsh = manifest['dsh']
    if (!isRecord(dsh) || dsh['bundle'] === undefined || dsh['bundle'] === null) continue

    const targets = dsh['targets']
    plugins.push({
      dirName: entry.name,
      dir,
      packageName: typeof manifest['name'] === 'string' ? manifest['name'] : entry.name,
      version: typeof manifest['version'] === 'string' ? manifest['version'] : '',
      manifest,
      dsh,
      surfaces: isRecord(targets) ? stringArray(targets['surfaces']) : [],
      platforms: isRecord(targets) ? stringArray(targets['platforms']) : [],
    })
  }

  // Directory order is filesystem-dependent; the PowerShell scripts produced a
  // stable alphabetical order and the catalog rows depend on it.
  return plugins.sort((left, right) => compare(left.dirName, right.dirName))
}

/** Code-unit comparison, so results never depend on the host locale. */
export function compare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
