import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dailyHash, plainPath } from '../../../scripts/.build/core/daily-contract.js'

// Fixed thin entry: all selection/validation remains in TypeScript, no shell logic.
try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const pointer = join(root, 'active.json'); plainPath(pointer)
  const active = JSON.parse(readFileSync(pointer, 'utf8'))
  if (active.version !== 1 || !/^[a-f\d]{64}$/.test(active.release) || !/^daily-[a-f\d-]{36}\.json$/.test(active.config)) throw new Error('invalid daily active pointer')
  const entry = join(root, 'releases', active.release, 'launcher.mjs')
  const config = join(root, 'config', active.config)
  for (const [path, hash] of [[entry, active.release], [config, active.configSha256]]) {
    plainPath(path)
    if (dailyHash(readFileSync(path)) !== hash) throw new Error('daily deployment hash mismatch; restore a verified active pointer from receipts')
  }
  const launcher = await import(pathToFileURL(entry).href)
  process.exitCode = await launcher.run(root, config, process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message.replace(/([?&](?:token|auth|key)=)[^\s&]+/gi, '$1[redacted]') : 'daily launcher failed')
  process.exitCode = 1
}
