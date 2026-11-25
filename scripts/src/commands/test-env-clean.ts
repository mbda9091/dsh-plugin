import { cleanupEnvironmentTests } from '../core/test-storage.js'
import { repoRoot } from '../core/repo.js'
import type { CleanupResult } from '../core/test-storage.js'

export function printCleanup(result: CleanupResult): void {
  console.log(`test cleanup: ${result.status}`)
  for (const item of result.items) console.log(`  ${item.action}${item.removed ? 'd' : ''}: ${item.path} (${item.reason})`)
  if (result.error) console.error(`test cleanup: ${result.error}`)
}

export async function runTestEnvClean(apply: boolean, root = repoRoot): Promise<number> {
  const result = await cleanupEnvironmentTests(root, apply)
  printCleanup(result)
  return result.status === 'failed' ? 1 : 0
}
