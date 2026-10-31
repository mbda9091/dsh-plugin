import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { inspect } from 'node:util'
import { run } from 'node:test'
import type { TestEvent } from 'node:test/reporters'
import { repoRoot } from '../core/repo.js'
import { digest, safeConfigPath } from '../core/config-transaction.js'
import { assertEnvironmentResults, environmentIds } from '../core/environment-results.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import { failureAnnotation } from '../core/github-annotations.js'

function reportFailure(detail: string): void {
  const message = redactLaunchTokens(detail)
  console.error(message)
  if (process.env.GITHUB_ACTIONS === 'true') console.error(failureAnnotation(message))
}

/** Deliberately dispatched before local configuration loading. */
export async function runTestEnv(suite: string, keep: boolean, pnpmScript?: string, only?: string, onReport?: (path: string) => void, browser?: { browser?: string | undefined; browserPath?: string | null | undefined }): Promise<number> {
  if (!['fast', 'real', 'all'].includes(suite)) throw new Error('--suite must be fast, real or all')
  const expected = only ? only.split(',') : environmentIds(suite)
  if (!expected.length || new Set(expected).size !== expected.length || expected.some(id => !environmentIds(suite).includes(id))) throw new Error('--only must name implemented cases in the selected suite')
  const base = join(repoRoot, '.tmp/environment-tests')
  safeConfigPath(repoRoot, base)
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'run-'))
  const reportPath = join(directory, 'report.json')
  const results: { id: string; name: string; status: string; durationMs: number; evidence: string }[] = []
  const sources: Record<string, string> = {}
  const fingerprint = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) fingerprint(path)
      else sources[relative(repoRoot, path)] = digest(readFileSync(path))
    }
  }
  for (const directory of ['scripts/src', 'test/src']) fingerprint(join(repoRoot, directory))
  for (const path of ['scripts/bootstrap.mjs', 'package.json', 'pnpm-workspace.yaml', 'scripts/config/schema.json', 'scripts/config/schema.v1.json', 'test/src/harness/environment.ts', 'test/src/harness/development.ts', 'test/src/harness/isolation.ts', 'profiles/web/cordis.dev.patch.yml', 'pnpm-lock.yaml']) sources[path] = digest(readFileSync(join(repoRoot, path)))
  const report = { version: 1, suite, selected: expected, platform: process.platform, node: process.version, nodePath: process.execPath,
    source: digest(JSON.stringify(sources)), sourceFiles: sources,
    typescript: JSON.parse(readFileSync(join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')).version as string,
    started: new Date().toISOString(), ended: '', status: 'failed', results, cleanup: 'per-case evidence', reason: '' }
  const oldRun = process.env.DSH_ENV_TEST_RUN
  const oldKeep = process.env.DSH_ENV_TEST_KEEP
  const oldPnpm = process.env.DSH_ENV_TEST_PNPM
  const oldOnly = process.env.DSH_ENV_TEST_ONLY
  const oldBrowser = process.env.DSH_ENV_TEST_BROWSER, oldBrowserPath = process.env.DSH_ENV_TEST_BROWSER_PATH
  try {
    if (suite !== 'fast' && !pnpmScript) throw new Error('real environment tests require explicit --pnpm-script')
    const compiled = spawnSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'test/tsconfig.environment.json')], { stdio: 'inherit' })
    if (compiled.error || compiled.status !== 0) throw new Error('environment test compilation failed; prepare workspace dependencies with pnpm install --frozen-lockfile')
    if (pnpmScript) process.env.DSH_ENV_TEST_PNPM = pnpmScript
    else delete process.env.DSH_ENV_TEST_PNPM
    process.env.DSH_ENV_TEST_RUN = directory
    process.env.DSH_ENV_TEST_KEEP = keep ? '1' : '0'
    process.env.DSH_ENV_TEST_ONLY = expected.join(',')
    if (browser?.browser) process.env.DSH_ENV_TEST_BROWSER = browser.browser
    if (browser?.browserPath) process.env.DSH_ENV_TEST_BROWSER_PATH = browser.browserPath
    const folders = suite === 'all' ? ['fast', 'real'] : [suite]
    const files = folders.flatMap(kind => { const folder = join(repoRoot, 'test/.build-env/environment', kind); return readdirSync(folder).filter(name => name.endsWith('.test.js')).map(name => join(folder, name)) })
    const stream = run({ files, isolation: 'none', concurrency: 1, testNamePatterns: [new RegExp(`^(?:${expected.join('|')}) `)] })
    for await (const raw of stream) {
      const event = raw as TestEvent
      if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
      const { data } = event
      const id = /^(?:CFG|TOOL|DEV|ISO|ART|TGT)-\d+(?:-real)?/.exec(data.name)?.[0]
      if (!id) continue
      const status = event.type === 'test:fail' ? 'fail' : data.skip ? 'skip' : 'pass'
      results.push({ id, name: data.name, status, durationMs: data.details.duration_ms ?? 0, evidence: `${id}.json` })
      console.log(`test-env: ${status} ${data.name}`)
      if (event.type === 'test:fail') reportFailure(`${id}: ${inspect(event.data.details.error, { depth: 6, colors: false })}`)
    }
    for (const id of expected) {
      if (!results.some(result => result.id === id && result.status === 'pass')) throw new Error(`missing passing evidence: ${id}`)
      const evidence: unknown = JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'))
      if (!evidence || typeof evidence !== 'object' || !('passed' in evidence) || evidence.passed !== true) throw new Error(`incomplete assertion/cleanup evidence: ${id}`)
    }
    if (results.some(result => result.status !== 'pass')) throw new Error('environment tests failed or skipped')
    report.status = 'passed'
    writeFileSync(reportPath, redactLaunchTokens(JSON.stringify(report, null, 2)))
    assertEnvironmentResults(reportPath, expected)
    return 0
  } catch (error) {
    report.status = 'failed'
    report.reason = redactLaunchTokens(error instanceof Error ? error.message : 'environment test runner failed')
    reportFailure(`test-env: ${report.reason}`)
    return 1
  } finally {
    if (oldRun === undefined) delete process.env.DSH_ENV_TEST_RUN; else process.env.DSH_ENV_TEST_RUN = oldRun
    if (oldKeep === undefined) delete process.env.DSH_ENV_TEST_KEEP; else process.env.DSH_ENV_TEST_KEEP = oldKeep
    if (oldPnpm === undefined) delete process.env.DSH_ENV_TEST_PNPM; else process.env.DSH_ENV_TEST_PNPM = oldPnpm
    if (oldOnly === undefined) delete process.env.DSH_ENV_TEST_ONLY; else process.env.DSH_ENV_TEST_ONLY = oldOnly
    if (oldBrowser === undefined) delete process.env.DSH_ENV_TEST_BROWSER; else process.env.DSH_ENV_TEST_BROWSER = oldBrowser
    if (oldBrowserPath === undefined) delete process.env.DSH_ENV_TEST_BROWSER_PATH; else process.env.DSH_ENV_TEST_BROWSER_PATH = oldBrowserPath
    report.ended = new Date().toISOString()
    writeFileSync(reportPath, redactLaunchTokens(JSON.stringify(report, null, 2)))
    onReport?.(reportPath)
    console.log(`test-env: report ${reportPath}`)
  }
}
