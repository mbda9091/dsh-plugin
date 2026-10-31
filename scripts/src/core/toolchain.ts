import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isRecord } from './json.js'
import type { DshRunner } from './dsh-cli.js'

export function checkNode(version = process.versions.node, electron = process.versions.electron): void {
  if (version.split('.')[0] !== '24' || electron !== undefined) {
    throw new Error(`ordinary Node 24 required; current Node ${version}${electron ? ' (Electron)' : ''}; select Node 24 explicitly, no automatic runtime switching`)
  }
}

export function expectedPnpm(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(manifest.packageManager ?? '')
  if (!match) throw new Error('root packageManager must pin an exact pnpm version')
  return match[1]!
}

export function pnpmVersion(script: string): string {
  const path = realpathSync(script)
  const manifest = JSON.parse(readFileSync(join(dirname(dirname(path)), 'package.json'), 'utf8'))
  if (manifest.name !== 'pnpm' || typeof manifest.version !== 'string') throw new Error('tools.pnpmScript: expected the pnpm package bin/pnpm.cjs entry')
  if (resolve(dirname(dirname(path)), 'bin/pnpm.cjs') !== path) throw new Error('tools.pnpmScript: expected the pnpm package bin/pnpm.cjs entry')
  return manifest.version
}

export function checkPnpm(script: string, root: string): string {
  const expected = expectedPnpm(root)
  let installed: string
  try { installed = pnpmVersion(script) } catch { throw new Error(`tools.pnpmScript: invalid pnpm package entry; prepare pnpm@${expected} and select its bin/pnpm.cjs`) }
  if (installed !== expected) throw new Error(`tools.pnpmScript: pnpm ${installed} does not match packageManager pnpm@${expected}; prepare that version explicitly`)
  return realpathSync(script)
}

export function workspaceDsh(root: string): DshRunner & { version: string } {
  const repair = 'run pnpm install --frozen-lockfile with the root packageManager version (M2); no fallback to legacy CLI'
  const manifest = join(root, 'package.json')
  const pkg = join(root, 'node_modules/@deepseek-ai/dsh/package.json')
  if (!existsSync(manifest) || !existsSync(pkg)) throw new Error(`workspace development DSH is not prepared; ${repair}`)
  const declared: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const installed: unknown = JSON.parse(readFileSync(pkg, 'utf8'))
  const version = isRecord(declared) && isRecord(declared.devDependencies) ? declared.devDependencies['@deepseek-ai/dsh'] : undefined
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !isRecord(installed) || installed.name !== '@deepseek-ai/dsh' || installed.version !== version) {
    throw new Error(`workspace DSH must match the exact declared development dependency; ${repair}`)
  }
  const bin = typeof installed.bin === 'string' ? installed.bin : isRecord(installed.bin) ? installed.bin.dsh : undefined
  if (typeof bin !== 'string') throw new Error(`workspace DSH has no public dsh bin entry; ${repair}`)
  const packageRoot = realpathSync(dirname(pkg))
  const entry = resolve(packageRoot, bin)
  const inside = (path: string) => { const rel = relative(packageRoot, path); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel) }
  if (!inside(entry) || !existsSync(entry) || !statSync(entry).isFile() || !inside(realpathSync(entry))) throw new Error(`workspace DSH public bin is missing or escapes its package; ${repair}`)
  return { command: process.execPath, source: realpathSync(entry), version, env: {}, verbatim: false, build: args => [realpathSync(entry), ...args] }
}
