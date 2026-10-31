import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, writeText } from '../core/json.js'
import { repoRoot } from '../core/repo.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { runBuild } from './build.js'
import { runTest } from './test.js'
import { runL4 } from './l4.js'
import { runL5 } from './l5.js'
import { configuredPnpm, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { runTestEnv } from './test-env.js'
import { assertEnvironmentResults, environmentIds } from '../core/environment-results.js'
import type { TestReport } from '../core/test-run.js'
import { assertTestReport } from '../core/test-run.js'

/** The same fail-fast verification pipeline runs locally and on CI runners. */
export async function runCi(options: { readonly keep: boolean; readonly timeoutMs?: number }, context: CommandContext = loadCommandContext({}, undefined, undefined, 'test')): Promise<number> {
  const testOptions = { ...options, timeoutMs: options.timeoutMs ?? context.config.test.timeoutMs }
  const base = join(repoRoot, '.tmp', 'ci')
  mkdirSync(base, { recursive: true })
  const runDir = mkdtempSync(join(base, 'run-'))
  const startedAt = new Date().toISOString()
  const steps: Array<{ name: string; exitCode: number; durationMs: number; error?: string }> = []
  const evidence: Record<string, string> = {}
  const collect = (report: TestReport) => { evidence[report.kind] = join(report.runDir, 'report.json') }
  const stages = [
    { name: 'environment', run: async () => {
      const started = new Date().toISOString()
      const code = await runTestEnv('all', options.keep, configuredPnpm(context), undefined, path => { evidence.environment = path })
      if (code !== 0) return code
      if (!evidence.environment) throw new Error('missing environment report')
      assertEnvironmentResults(evidence.environment, environmentIds('all'), started)
      return 0
    } },
    { name: 'type-check', run: () => runBuild({ check: true }, context) },
    { name: 'l1-l3', run: () => runTest({ kinds: [], build: true }, context) },
    { name: 'l4', run: () => runL4({ ...testOptions, home: undefined, skipTarball: false }, context, collect) },
    { name: 'l5', run: () => runL5(testOptions, context, collect) },
  ]
  let exitCode = 0
  try {
    for (const stage of stages) {
      console.log(`ci: START ${stage.name}`)
      const started = Date.now()
      const startedAt = new Date(started).toISOString()
      let error: string | undefined
      try {
        exitCode = await stage.run()
        if (exitCode === 0 && ['l4', 'l5'].includes(stage.name) && !evidence[stage.name]) throw new Error(`missing ${stage.name} report`)
        if (exitCode === 0 && (stage.name === 'l4' || stage.name === 'l5')) assertTestReport(evidence[stage.name]!, stage.name, startedAt)
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
      node: process.version, runDir, evidence, steps,
    }
    const content = `${JSON.stringify(report, null, 2)}\n`
    writeText(join(runDir, 'report.json'), content)
    writeText(join(base, 'last-report.json'), content)
    console.log(`ci: report -> ${join(runDir, 'report.json')}`)
  }
  return exitCode
}
