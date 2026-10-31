import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { envValue } from './config.js'

/** Discovery is for config init only. Runtime commands use configuredPnpm. */
export function discoverPnpmScript(env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = []
  for (const directory of (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    // npm's Windows prefix and Unix prefix/bin layouts. Resolve symlinks,
    // never execute shell wrappers, Corepack or standalone pnpm binaries.
    candidates.push(join(directory, 'node_modules/pnpm/bin/pnpm.cjs'), join(directory, '../lib/node_modules/pnpm/bin/pnpm.cjs'))
    for (const name of ['pnpm', 'pnpm.cjs']) {
      const entry = join(directory, name)
      try {
        const actual = realpathSync(entry)
        if (actual.endsWith('/pnpm.cjs') || actual.endsWith('\\pnpm.cjs')) candidates.push(actual)
        candidates.push(join(dirname(actual), '../pnpm/bin/pnpm.cjs'))
      } catch { /* Missing PATH entries are not errors. */ }
    }
  }
  return candidates.find(path => existsSync(path)) ?? null
}

/** DSH's plugin manager also invokes pnpm; make it use the selected script. */
export function writePnpmShim(directory: string, script: string): void {
  mkdirSync(directory, { recursive: true })
  if (process.platform === 'win32') {
    const batchPath = (path: string) => path.replaceAll('%', '%%')
    writeFileSync(join(directory, 'pnpm.cmd'), `@echo off\r\n"${batchPath(process.execPath)}" "${batchPath(script)}" %*\r\n`)
  } else {
    const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'"
    const path = join(directory, 'pnpm')
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
    chmodSync(path, 0o755)
  }
}
