import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runL4 } from '../../../scripts/.build/commands/l4.js'
import { withEnv } from '../harness/env.js'
import { removeDir, repoRoot } from '../harness/tmp.js'

it('L3 L4 harness: retains logs and a per-run report on failure without --keep', async () => {
  // Node rejects DSH flags without touching any profile or starting a server.
  const reportPath = join(repoRoot, '.tmp/l4/last-report.json')
  const previous = existsSync(reportPath) ? readFileSync(reportPath) : undefined
  try {
    await withEnv('DSH_CLI', process.execPath, () => withEnv('DSH_PNPM', process.execPath, async () => {
      // The generated pnpm shim is never invoked: profile-init fails first.
      const code = await runL4({ keep: false, skipTarball: true, timeoutMs: 5_000 })
      assert.equal(code, 1)
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        runDir: string
        ok: boolean
        steps: { name: string }[]
      }
      const runDir = report.runDir
      // Never delete anything outside the harness's generated run directory.
      const inside = relative(join(repoRoot, '.tmp/l4'), runDir)
      assert.ok(inside !== '' && !inside.startsWith('..') && !inside.includes(':'))
      try {
        assert.equal(report.ok, false)
        assert.equal(report.steps.at(-1)?.name, 'profile-init')
        assert.ok(existsSync(join(runDir, 'logs/profile-init.err.log')))
        assert.notEqual(readFileSync(join(runDir, 'logs/profile-init.err.log'), 'utf8').trim(), '')
        assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')), report)
      } finally {
        removeDir(runDir)
      }
    }))
  } finally {
    // A deliberate failure in this unit test must not replace the user's real L4 result.
    if (previous === undefined) rmSync(reportPath, { force: true })
    else writeFileSync(reportPath, previous)
  }
})
