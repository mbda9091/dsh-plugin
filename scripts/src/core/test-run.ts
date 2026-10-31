import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuredDsh } from './command-context.js'
import type { CommandContext } from './command-context.js'
import { freshTestHome, preparePackageEnvironment, removeTestData, validateTestRoot } from './test-isolation.js'
import { redactLaunchTokens } from './web-harness.js'
import type { WebHarness } from './web-harness.js'
import { isRecord, writeText } from './json.js'

export const requiredTestSteps = {
  l4: ['context', 'prerequisites', 'profile-init', 'install-link', 'web-link', 'install-mismatch', 'web-mismatch', 'install-tarball', 'web-tarball', 'cleanup'],
  l5: ['context', 'build', 'compile-browser', 'prerequisites', 'profile-init', 'baseline', 'install-fixture', 'fixture', 'cleanup'],
} as const

export function assertTestReport(path: string, kind: 'l4' | 'l5', startedAfter: string): void {
  const report: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const expected = requiredTestSteps[kind]
  if (!isRecord(report) || report.version !== 1 || report.kind !== kind || report.ok !== true
    || typeof report.startedAt !== 'string' || report.startedAt < startedAfter
    || !Array.isArray(report.steps) || report.steps.length !== expected.length
    || report.steps.some((s, i) => !isRecord(s) || s.name !== expected[i] || s.ok !== true)
    || typeof report.cleanup !== 'string' || !/^(removed|retained --keep)/.test(report.cleanup)) throw new Error(`incomplete or failed ${kind} report`)
}

export interface TestStep { name: string; ok: boolean; durationMs: number; detail?: string }
export interface TestReport {
  version: 1; kind: string; ok: boolean; runDir: string; home?: string; dsh?: string
  platform: string; node: string; startedAt: string; finishedAt: string
  cleanup: string; steps: TestStep[]
}
export interface TestRun extends WebHarness {
  step(name: string, body: () => Promise<string | undefined>): Promise<void>
}

/** One owned run, one durable report. All failures, including cleanup, are failures.
 * Signal handlers only cancel this run; serveAndCheck owns and awaits its children.
 */
export async function runIsolatedTest(
  kind: string, settings: CommandContext, options: { keep: boolean; timeoutMs: number; home?: string | undefined },
  body: (context: TestRun) => Promise<void>, onReport?: (report: TestReport) => void,
): Promise<number> {
  const base = join(settings.root, '.tmp', kind)
  validateTestRoot(settings, base)
  mkdirSync(base, { recursive: true })
  const runDir = mkdtempSync(join(base, 'run-'))
  const report: TestReport = { version: 1, kind, ok: false, runDir, platform: process.platform, node: process.version,
    startedAt: new Date().toISOString(), finishedAt: '', cleanup: 'retained failure', steps: [] }
  const controller = new AbortController()
  const interrupt = (signal: string) => controller.abort(new Error(`test interrupted: ${signal}`))
  const int = () => interrupt('SIGINT'), term = () => interrupt('SIGTERM')
  process.on('SIGINT', int); process.on('SIGTERM', term)
  const step = async (name: string, action: () => Promise<string | undefined>) => {
    const start = Date.now()
    try {
      controller.signal.throwIfAborted()
      const detail = await action()
      controller.signal.throwIfAborted()
      report.steps.push({ name, ok: true, durationMs: Date.now() - start, ...(detail === undefined ? {} : { detail: redactLaunchTokens(detail) }) })
      console.log(`${kind}: PASS ${name}`)
    } catch (error) {
      const detail = redactLaunchTokens(error instanceof Error ? error.message : String(error))
      report.steps.push({ name, ok: false, durationMs: Date.now() - start, detail })
      throw error
    }
  }
  console.log(`${kind}: run -> ${runDir}`)
  try {
    let context!: TestRun
    await step('context', async () => {
      const home = freshTestHome(settings.root, runDir, options.home)
      validateTestRoot(settings, home)
      const runner = configuredDsh(settings, true)
      report.home = home; report.dsh = runner.source
      // Reserve atomically: two runs cannot claim the same explicit home.
      mkdirSync(join(home, '..'), { recursive: true }); mkdirSync(home)
      preparePackageEnvironment(runDir)
      context = { settings, runner, runDir, home, logDir: join(runDir, 'logs'), options, signal: controller.signal, step }
      return 'locked workspace host; fresh owned home and package configuration'
    })
    await body(context)
    await step('cleanup', async () => {
      if (options.keep) { report.cleanup = 'retained --keep'; return report.cleanup }
      const paths = [context.home, ...['dsh-home-tarball', 'pnpm-store', 'bin', 'npmrc', 'global.npmrc', 'cache', 'config', 'data', 'pnpm-home', 'workspace'].map(name => join(runDir, name))]
      paths.forEach(path => validateTestRoot(settings, path))
      paths.forEach(path => removeTestData(settings.root, path))
      report.cleanup = 'removed owned mutable data; retained report/logs/artifacts'
      return report.cleanup
    })
    report.ok = true
  } catch (error) {
    const detail = redactLaunchTokens(error instanceof Error ? error.message : String(error))
    if (report.steps.at(-1)?.ok !== false) report.steps.push({ name: 'execution', ok: false, durationMs: 0, detail })
    console.error(`${kind}: FAIL ${detail}`)
    if (report.steps.at(-1)?.name === 'cleanup') report.cleanup = 'failed; retained remaining data'
  } finally {
    process.off('SIGINT', int); process.off('SIGTERM', term)
    report.finishedAt = new Date().toISOString()
    const content = `${JSON.stringify(report, null, 2)}\n`
    writeText(join(runDir, 'report.json'), content)
    writeText(join(base, 'last-report.json'), content)
    onReport?.(report)
    console.log(`${kind}: report -> ${join(runDir, 'report.json')}`)
  }
  return report.ok ? 0 : 1
}
