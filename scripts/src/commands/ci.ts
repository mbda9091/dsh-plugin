import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, writeText } from '../core/json.js'
import { repoRoot } from '../core/repo.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { runBuild } from './build.js'
import { runTest } from './test.js'
import { runL4 } from './l4.js'
import { runL5 } from './l5.js'

/** The same fail-fast verification pipeline runs locally and on CI runners. */
export async function runCi(options: { readonly keep: boolean; readonly timeoutMs: number }): Promise<number> {
  const base = join(repoRoot, '.tmp', 'ci')
  mkdirSync(base, { recursive: true })
  const runDir = mkdtempSync(join(base, 'run-'))
  const startedAt = new Date().toISOString()
  const steps: Array<{ name: string; exitCode: number; durationMs: number; error?: string }> = []
  const stages = [
    { name: 'type-check', run: () => runBuild({ check: true }) },
    { name: 'l1-l3', run: () => runTest({ kinds: [], build: true }) },
    { name: 'l4', run: () => runL4({ ...options, home: undefined, skipTarball: false }) },
    { name: 'l5', run: () => runL5(options) },
  ]
  let exitCode = 0
  try {
    for (const stage of stages) {
      console.log(`ci: START ${stage.name}`)
      const started = Date.now()
      let error: string | undefined
      try {
        exitCode = await stage.run()
      } catch (caught) {
        exitCode = 1
        error = redactLaunchTokens(errorMessage(caught))
        console.error(`ci: ${error}`)
      }
      steps.push({ name: stage.name, exitCode, durationMs: Date.now() - started, ...(error === undefined ? {} : { error }) })
      console.log(`ci: ${exitCode === 0 ? 'PASS' : 'FAIL'} ${stage.name}`)
      if (exitCode !== 0) break
    }
  } finally {
    const report = {
      ok: exitCode === 0 && steps.length === stages.length,
      startedAt, finishedAt: new Date().toISOString(), platform: process.platform,
      node: process.version, runDir, steps,
    }
    const content = `${JSON.stringify(report, null, 2)}\n`
    writeText(join(runDir, 'report.json'), content)
    writeText(join(base, 'last-report.json'), content)
    console.log(`ci: report -> ${join(runDir, 'report.json')}`)
  }
  return exitCode
}
