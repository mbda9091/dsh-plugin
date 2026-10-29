import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { envValue } from './config.js'

/** Discovery is for config init only. Runtime commands use configuredPnpm. */
export function discoverPnpmScript(env: NodeJS.ProcessEnv): string | null {
  const homes = [envValue(env, 'DSH_HOME'), join(homedir(), '.dsh')].filter(
    (home, index, all): home is string => Boolean(home) && all.indexOf(home) === index,
  )
  const candidates: string[] = []
  for (const home of homes) {
    const runtimes = join(home, 'dsh-runtimes')
    if (!existsSync(runtimes)) continue
    for (const entry of readdirSync(runtimes, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(runtimes, entry.name, 'dependencies/pnpm/bin/pnpm.cjs'))
    }
  }
  return candidates.sort().find(path => existsSync(path)) ?? null
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
