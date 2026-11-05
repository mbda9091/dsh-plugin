import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadArtifacts, sourceState } from './artifacts.js'
import { assertCurrentBuild } from './build-record.js'
import { toolFingerprint } from './build-record.js'
import { safeConfigPath } from './config-transaction.js'

export function installCache(root: string, rebuild = false): { mode: 'reuse-tarball' | 'reuse-build' | 'rebuild'; reason: string; manifest?: string } {
  if (rebuild) return { mode: 'rebuild', reason: '--rebuild' }
  const pointerPath = join(root, 'dist/current.json')
  safeConfigPath(root, pointerPath)
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
    if (pointer.version !== 1 || !/^[a-f\d-]{36}$/.test(pointer.batch) || pointer.manifest !== `batches/${pointer.batch}/manifest.json`) throw new Error('invalid current artifact pointer; use --rebuild')
    const path = join(root, 'dist', pointer.manifest)
    if (existsSync(path)) {
      safeConfigPath(root, path)
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.version !== 1 || manifest.batch !== pointer.batch || !manifest.source || !Array.isArray(manifest.packages)) throw new Error('invalid artifact manifest; use --rebuild')
      if (JSON.stringify(manifest.source) === JSON.stringify(sourceState(root))
        && JSON.stringify(manifest.fingerprint) === JSON.stringify(toolFingerprint(root))) {
        try {
          loadArtifacts(root, path)
          return { mode: 'reuse-tarball', reason: 'source, tools and archive hashes match', manifest: path }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
  }
  try { assertCurrentBuild(root); return { mode: 'reuse-build', reason: 'successful build outputs match; no current tarball' } }
  catch { return { mode: 'rebuild', reason: 'source/tools/outputs changed or no successful build record' } }
}
