import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { envValue } from './config.js'
import { runToTemporaryFiles } from './exec.js'

/** Resolve supported npm package layouts; runtime consumers use configuredPnpm. */
export function discoverPnpmScript(env: NodeJS.ProcessEnv, root = process.cwd()): string | null {
  const candidates: string[] = []
  const corepack: string[] = []
  for (const directory of (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    // npm's Windows prefix and Unix prefix/bin layouts. Resolve symlinks,
    // Shell wrappers are never executed; known Corepack JS entries are probed below.
    candidates.push(join(directory, 'node_modules/pnpm/bin/pnpm.cjs'), join(directory, '../lib/node_modules/pnpm/bin/pnpm.cjs'))
    corepack.push(join(directory, 'node_modules/corepack/dist/pnpm.js'), join(directory, '../lib/node_modules/corepack/dist/pnpm.js'))
    for (const name of ['pnpm', 'pnpm.cjs']) {
      const entry = join(directory, name)
      try {
        const actual = realpathSync(entry)
        if (actual.endsWith('/dist/pnpm.js') || actual.endsWith('\\dist\\pnpm.js')) corepack.push(actual)
        if (actual.endsWith('/pnpm.cjs') || actual.endsWith('\\pnpm.cjs')) candidates.push(actual)
        candidates.push(join(dirname(actual), '../pnpm/bin/pnpm.cjs'))
      } catch { /* Missing PATH entries are not errors. */ }
    }
  }
  const direct = candidates.find(path => existsSync(path))
  if (direct) return direct
  for (const entry of corepack) {
    if (!existsSync(entry)) continue
    const actual = realpathSync(entry)
    try {
      if (JSON.parse(readFileSync(join(dirname(dirname(actual)), 'package.json'), 'utf8')).name !== 'corepack') continue
    } catch { continue }
    // Ask the prepared package manager for its own entry. Corepack resolves the
    // repository's packageManager; no cache scanning, downloading or auto-pinning.
    let reported: string
    try {
      const result = runToTemporaryFiles(root, process.execPath, [actual, 'exec', process.execPath, '-p', 'process.env.npm_execpath'], {
        cwd: root, env: { ...env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0',
          COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_ENABLE_PROJECT_SPEC: '1', COREPACK_ENABLE_STRICT: '1', COREPACK_ENV_FILE: '0' },
        timeoutMs: 15000,
      })
      if (result.status !== 0 || result.timedOut) throw new Error('Corepack probe failed')
      reported = result.stdout.trim()
    } catch { throw new Error('cannot resolve prepared pnpm through Corepack; prepare the repository packageManager version first (automatic download disabled)') }
    if (!isAbsolute(reported) || /[\0\r\n]/.test(reported) || !/[/\\]pnpm\.(?:cjs|mjs)$/.test(reported)) {
      throw new Error('Corepack pnpm returned an invalid package entry')
    }
    // pnpm 11 reports bin/pnpm.mjs; the existing runner uses the same package's
    // bin/pnpm.cjs. configuredPnpm still checks package identity and exact version.
    const script = join(dirname(realpathSync(reported)), 'pnpm.cjs')
    if (!existsSync(script)) throw new Error('resolved pnpm package has no bin/pnpm.cjs')
    return script
  }
  return null
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
