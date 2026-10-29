import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { resolveDsh } from './dsh-cli.js'
import type { DshRunner } from './dsh-cli.js'
import { envValue } from './config.js'
import { discoverPnpmScript } from './pnpm.js'

export function requireFile(path: string, field: string): string {
  try { if (statSync(path).isFile()) return path } catch { /* Report the field, not file contents. */ }
  throw new Error(`${field}: file does not exist: ${path}`)
}

/** Use the existing shim reader, but never launch Web through Electron or an
 * opaque shell wrapper. No CLI execution/profile creation during discovery. */
export function webDsh(path: string, env: NodeJS.ProcessEnv = process.env): DshRunner {
  requireFile(path, 'tools.dshCli')
  const runner = resolveDsh({ env: { ...env, DSH_CLI: path } })
  if (runner.env['ELECTRON_RUN_AS_NODE'] !== undefined) {
    throw new Error('tools.dshCli: Electron CLI cannot run the Web target; select a plain-Node DSH CLI with --dsh-cli')
  }
  if (runner.command === process.execPath && !runner.verbatim) return runner
  if (process.platform !== 'win32' && !runner.verbatim && /^#![^\r\n]*\bnode\b/.test(readFileSync(runner.command, 'utf8').slice(0, 200))) return runner
  throw new Error('tools.dshCli: unrecognized CLI engine; select a plain-Node DSH CLI with --dsh-cli')
}

export function discoverDsh(explicit: string | null, env: NodeJS.ProcessEnv): { path: string; source: string } {
  if (explicit !== null) { webDsh(explicit, env); return { path: explicit, source: 'configured' } }
  const candidates: Array<{ path: string; source: string }> = []
  for (const directory of (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat'] : ['dsh']) {
      candidates.push({ path: join(directory, name), source: 'PATH' })
    }
  }
  const local = envValue(env, 'LOCALAPPDATA')
  if (local !== undefined) candidates.push({ path: join(local, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'), source: 'desktop installation' })
  if (process.platform === 'darwin') candidates.push({ path: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', source: 'desktop installation' })
  const rejected: string[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    try { webDsh(candidate.path, env); return candidate } catch (error) {
      rejected.push(`${candidate.path}: ${error instanceof Error ? error.message : 'unrecognized CLI'}`)
    }
  }
  throw new Error(`cannot locate a plain-Node DSH CLI; pass --dsh-cli <path> or set DSH_CLI${rejected.length ? `\n${rejected.join('\n')}` : ''}`)
}

export function discoverPnpm(explicit: string | null, env: NodeJS.ProcessEnv): string | null {
  if (explicit !== null) return requirePnpm(explicit)
  const candidate = discoverPnpmScript(env)
  return candidate === null ? null : requirePnpm(candidate)
}

export function requirePnpm(path: string): string {
  if (!/[/\\]pnpm\.cjs$/i.test(path)) throw new Error('tools.pnpmScript: expected a path to pnpm.cjs')
  return requireFile(path, 'tools.pnpmScript')
}

export function discoverBrowser(kind: 'edge' | 'chrome', env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = []
  const windowsSuffix = kind === 'edge' ? 'Microsoft/Edge/Application/msedge.exe' : 'Google/Chrome/Application/chrome.exe'
  if (process.platform === 'win32') {
    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
      const base = envValue(env, variable)
      if (base !== undefined) candidates.push(join(base, windowsSuffix))
    }
    for (const base of (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
      candidates.push(join(base, kind === 'edge' ? 'msedge.exe' : 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push(kind === 'edge' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  }
  return candidates.find(path => { try { return statSync(path).isFile() } catch { return false } }) ?? null
}
