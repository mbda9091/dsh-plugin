import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { run } from 'node:test'
import type { TestEvent } from 'node:test/reporters'
import { repoRoot } from '../core/repo.js'
import { digest } from '../core/config-transaction.js'

/** Deliberately dispatched before local configuration loading. */
export async function runTestEnv(suite: string, keep: boolean): Promise<number> {
  if (!['fast', 'real', 'all'].includes(suite)) throw new Error('--suite must be fast, real or all')
  const base = join(repoRoot, '.tmp/environment-tests')
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
  for (const directory of ['scripts/src', 'test/src/environment']) fingerprint(join(repoRoot, directory))
  for (const path of ['scripts/config/schema.json', 'scripts/config/schema.v1.json', 'test/src/harness/environment.ts', 'pnpm-lock.yaml']) sources[path] = digest(readFileSync(join(repoRoot, path)))
  const report = { version: 1, suite, platform: process.platform, node: process.version, nodePath: process.execPath,
    source: digest(JSON.stringify(sources)), sourceFiles: sources,
    typescript: JSON.parse(readFileSync(join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')).version as string,
    started: new Date().toISOString(), ended: '', status: 'failed', results, cleanup: 'per-case evidence', reason: '' }
  const oldRun = process.env.DSH_ENV_TEST_RUN
  const oldKeep = process.env.DSH_ENV_TEST_KEEP
  try {
    const compiled = spawnSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'test/tsconfig.environment.json')], { stdio: 'inherit' })
    if (compiled.error || compiled.status !== 0) throw new Error('environment test compilation failed; prepare workspace dependencies with pnpm install --frozen-lockfile')
    if (suite === 'real') throw new Error('real environment suite is not implemented until M2; no real evidence')
    process.env.DSH_ENV_TEST_RUN = directory
    process.env.DSH_ENV_TEST_KEEP = keep ? '1' : '0'
    const folder = join(repoRoot, 'test/.build-env/environment/fast')
    const files = readdirSync(folder).filter(name => name.endsWith('.test.js')).map(name => join(folder, name))
    const stream = run({ files, isolation: 'none', concurrency: 1 })
    for await (const raw of stream) {
      const event = raw as TestEvent
      if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
      const { data } = event
      const id = /^CFG-\d+/.exec(data.name)?.[0]
      if (!id) continue
      const status = event.type === 'test:fail' ? 'fail' : data.skip ? 'skip' : 'pass'
      results.push({ id, name: data.name, status, durationMs: data.details.duration_ms ?? 0, evidence: `${id}.json` })
      console.log(`test-env: ${status} ${data.name}`)
      if (event.type === 'test:fail') console.error(event.data.details.error)
    }
    for (const id of ['CFG-01', 'CFG-02', 'CFG-03', 'CFG-04', 'CFG-05', 'CFG-06']) {
      if (!results.some(result => result.id === id && result.status === 'pass')) throw new Error(`missing passing evidence: ${id}`)
      const evidence: unknown = JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'))
      if (!evidence || typeof evidence !== 'object' || !('passed' in evidence) || evidence.passed !== true) throw new Error(`incomplete assertion/cleanup evidence: ${id}`)
    }
    if (results.some(result => result.status !== 'pass')) throw new Error('environment tests failed or skipped')
    if (suite === 'all') throw new Error('fast complete; real suite pending M2; all cannot pass')
    report.status = 'passed'
    return 0
  } catch (error) {
    report.reason = error instanceof Error ? error.message : 'environment test runner failed'
    console.error(`test-env: ${report.reason}`)
    return 1
  } finally {
    if (oldRun === undefined) delete process.env.DSH_ENV_TEST_RUN; else process.env.DSH_ENV_TEST_RUN = oldRun
    if (oldKeep === undefined) delete process.env.DSH_ENV_TEST_KEEP; else process.env.DSH_ENV_TEST_KEEP = oldKeep
    report.ended = new Date().toISOString()
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`test-env: report ${reportPath}`)
  }
}
