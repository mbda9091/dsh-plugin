import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { cleanupEnvironmentTests } from '../core/test-storage.js'
import { runToTemporaryFiles } from '../core/exec.js'
import { errorMessage } from '../core/json.js'
import { repoRoot } from '../core/repo.js'
import { printCleanup } from './test-env-clean.js'

/** The clock is injectable for local integration tests; the CLI never overrides it. */
export async function runPush(args: readonly string[], root = repoRoot, now = Date.now()): Promise<number> {
  root = realpathSync(root)
  const identity = runToTemporaryFiles(root, 'git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 30000 })
  if (identity.status !== 0 || realpathSync(identity.stdout.trim()) !== root) throw new Error('push requires the script repository Git root')
  const result = spawnSync('git', ['-C', root, 'push', ...args], { cwd: root, stdio: 'inherit' })
  if (result.error) throw new Error(`cannot run git push: ${result.error.message}`)
  if (result.status !== 0) return result.status ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1)
  const separator = args.indexOf('--'), options = separator < 0 ? args : args.slice(0, separator)
  const simulated = options.some(arg => (arg.startsWith('--') && arg.length > 2 && '--dry-run'.startsWith(arg))
    || /^-[^-]*n/.test(arg) || ['-h', '--help', '--version'].includes(arg))
  if (simulated) { console.log('push: simulation/help completed; historical cleanup not triggered'); return 0 }
  console.log('push: succeeded')
  try {
    const cleanup = await cleanupEnvironmentTests(root, true, now)
    printCleanup(cleanup)
    if (cleanup.status !== 'passed') console.error('push succeeded; cleanup did not complete, do not repeat the push to retry cleanup')
  } catch (error) { console.error(`push succeeded; cleanup failed: ${errorMessage(error)}`) }
  return 0
}
