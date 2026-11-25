import { existsSync, readFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { digest } from './config-transaction.js'
import { runToFilesAsync } from './exec.js'
import type { RunOptions } from './exec.js'
import { isRecord } from './json.js'

// These affect authentication, transport or storage, not installed package contents.
const transport = new Set(['cacheDir', 'storeDir', 'stateDir', 'globalDir', 'globalBinDir', 'pnpmHome', 'userAgent',
  'fetchRetries', 'fetchRetryFactor', 'fetchRetryMintimeout', 'fetchRetryMaxtimeout', 'fetchTimeout', 'networkConcurrency',
  'proxy', 'httpsProxy', 'httpProxy', 'noProxy', 'strictSsl', 'ca', 'cafile', 'cert', 'certfile', 'key', 'keyfile'].map(key => key.replace(/[-_]/g, '').toLowerCase()))

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !/auth|password|token|secret/i.test(key) && !transport.has(key.replace(/[-_]/g, '').toLowerCase()))
    .map(key => [key, normalized(value[key])]))
}

function hookInputs(config: Record<string, unknown>): unknown {
  const setting = (name: string) => Object.entries(config).find(([key]) => key.replace(/[-_]/g, '').toLowerCase() === name)?.[1]
  if (setting('ignorepnpmfile') === true || setting('ignorepnpmfile') === 'true') return []
  const configured = [setting('globalpnpmfile'), setting('pnpmfile')].flat().filter((path): path is string => typeof path === 'string')
  // config list may omit defaults; include the default hook when present.
  const defaults = ['.pnpmfile.mjs', '.pnpmfile.cjs'].map(path => resolve(path))
  const paths = configured.map(path => resolve(path))
  if (!setting('pnpmfile')) paths.push(...defaults.filter(existsSync).slice(0, 1))
  return [...new Set(paths)].sort().map(path => [path, digest(readFileSync(path))])
}

export async function pnpmInstallConfig(script: string, options: RunOptions): Promise<string> {
  const result = await runToFilesAsync(process.execPath, [fileURLToPath(import.meta.url), '--probe', script], options)
  const hash = result.stdout.trim()
  if (result.status !== 0 || result.signal || result.timedOut || !/^[a-f\d]{64}$/.test(hash)) {
    throw new Error('cannot inspect effective pnpm installation configuration; no configuration values were logged')
  }
  return hash
}

/** Query the selected public CLI in memory. Only a hash ever reaches captured files. */
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--probe') {
  const script = process.argv[3]!
  let output = '', overflow = false
  const capture = (keep: boolean): typeof process.stdout.write => (chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    if (keep && !overflow) {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (Buffer.byteLength(output) > 1024 * 1024) { output = ''; overflow = true }
    }
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    done?.()
    return true
  }
  process.stdout.write = capture(true)
  process.stderr.write = capture(false)
  process.once('exit', code => {
    try {
      if (code !== 0 || overflow) throw new Error('configuration query failed')
      const config: unknown = JSON.parse(output)
      if (!isRecord(config)) throw new Error('invalid configuration')
      writeSync(1, digest(JSON.stringify({ settings: normalized(config), hooks: hookInputs(config) })) + '\n')
    } catch {
      process.exitCode = 1
      writeSync(2, 'pnpm installation configuration query failed\n')
    }
  })
  process.argv = [process.execPath, script, 'config', 'list', '--json']
  await import(pathToFileURL(script).href)
}
