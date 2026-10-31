import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceState } from './artifacts.js'
import type { SourceState } from './artifacts.js'
import { digest, safeConfigPath } from './config-transaction.js'
import { discoverPlugins } from './plugins.js'

function outputs(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (path: string) => {
    if (!existsSync(path)) return
    if (lstatSync(path).isSymbolicLink()) throw new Error(`build output must not be a link: ${path}`)
    if (lstatSync(path).isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child))
    else files[relative(root, path).replaceAll('\\', '/')] = digest(readFileSync(path))
  }
  for (const plugin of discoverPlugins(root)) visit(join(plugin.dir, 'lib'))
  const libraries = join(root, 'packages')
  if (existsSync(libraries)) for (const name of readdirSync(libraries).sort()) visit(join(libraries, name, 'lib'))
  return files
}

/** Invalidate previous success before any compiler writes. */
export function beginBuild(root: string): SourceState {
  const directory = join(root, 'dist')
  safeConfigPath(root, join(directory, 'build-generation')); mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'build-generation'), randomUUID())
  return sourceState(root)
}

/** Only called after every compiler/bundler succeeds. */
export function completeBuild(root: string, source: SourceState): void {
  if (!source.build || JSON.stringify(sourceState(root)) !== JSON.stringify(source)) throw new Error('source changed during build; rebuild before packing')
  const path = join(root, 'dist/build-record.json'); safeConfigPath(root, path)
  writeFileSync(path, JSON.stringify({ version: 1, source, outputs: outputs(root) }, null, 2) + '\n')
}

export function assertCurrentBuild(root: string): void {
  const path = join(root, 'dist/build-record.json'); safeConfigPath(root, path)
  if (!existsSync(path)) throw new Error('missing successful build record; run build before pack --skip-build')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (record.version !== 1 || !record.source?.build || JSON.stringify(record.source) !== JSON.stringify(sourceState(root))
    || JSON.stringify(record.outputs) !== JSON.stringify(outputs(root))) {
    throw new Error('stale build: source or outputs changed, or build did not finish; run build before packing')
  }
}
