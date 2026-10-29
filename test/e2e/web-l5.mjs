// Compatibility entry: the formal harness owns its isolated server and artifacts.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/bootstrap.mjs', import.meta.url)), 'l5', ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
