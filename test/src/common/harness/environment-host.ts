import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environmentCase, sourceRoot } from './environment.js'
import { acquireEnvironmentHost, EnvironmentHostError, environmentHostCases, supportsSharedEnvironmentHost } from "../../../../scripts/.build/core/environment-host.js"
import type { EnvironmentHostLease } from "../../../../scripts/.build/core/environment-host.js"
import { redactLaunchTokens } from "../../../../scripts/.build/core/web-harness.js"
import { OwnedProcesses } from "../../../../scripts/.build/core/owned-processes.js"
import { runToFilesAsync } from "../../../../scripts/.build/core/exec.js"
import { workspaceDshVersion } from './dsh-version.js'

let lease: EnvironmentHostLease | undefined
let pending: Promise<EnvironmentHostLease> | undefined
let run: string | undefined
const cases = environmentHostCases()
const processes = new OwnedProcesses()
const save = () => {
  if (lease && run) writeFileSync(join(run, 'shared-host.json'), redactLaunchTokens(JSON.stringify(lease.evidence, null, 2)))
}

/** Lazy: importing the real test file for another --only selection prepares nothing. */
export async function sharedEnvironmentHost(id: string, home: string): Promise<EnvironmentHostLease> {
  run = process.env.DSH_ENV_TEST_RUN
  const pnpmScript = process.env.DSH_ENV_TEST_PNPM
  if (!run || !pnpmScript) throw new Error('shared host requires the environment test runner')
  pending ??= acquireEnvironmentHost({ root: sourceRoot, runDir: run, pnpmScript, processes })
  try { lease = await pending }
  catch (error) {
    const evidence = error instanceof EnvironmentHostError ? error.evidence : { version: 1, run, status: 'failed', installCount: 0,
      error: error instanceof Error ? error.message : String(error) }
    if (error instanceof EnvironmentHostError && !error.evidence.users.some(user => user.id === id)) error.evidence.users.push({ id, home })
    writeFileSync(join(run, 'shared-host.json'), redactLaunchTokens(JSON.stringify(evidence, null, 2)))
    throw error
  }
  lease.verify()
  lease.evidence.users.push({ id, home }); save()
  return lease
}

/** Windows keeps the pre-sharing, per-case host instead of claiming unsafe reuse. */
export async function environmentTargetHost(id: string, root: string, home: string, env: NodeJS.ProcessEnv): Promise<{ host: string; entry: string }> {
  if (supportsSharedEnvironmentHost()) return (await sharedEnvironmentHost(id, home)).evidence
  const host = join(root, '.formal-host'), preparation = join(root, '.formal-preparation')
  mkdirSync(host); mkdirSync(preparation)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': workspaceDshVersion } }))
  writeFileSync(join(host, 'pnpm-workspace.yaml'), readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8').replace(/packages:\r?\n(?:  .*\r?\n)+/, 'packages: []\n'))
  const result = await runToFilesAsync(process.execPath, [process.env.DSH_ENV_TEST_PNPM!, 'install'], {
    cwd: host, env, timeoutMs: 300_000, stdoutPath: join(preparation, 'install.out'), stderrPath: join(preparation, 'install.err') })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return { host, entry: realpathSync(join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js')) }
}

export function sharedEnvironmentCase(id: string, signal: AbortSignal, body: Parameters<typeof environmentCase>[1]): Promise<void> {
  const execute = () => environmentCase(id, async fixture => {
    signal.throwIfAborted()
    await body(fixture)
    signal.throwIfAborted()
    if (supportsSharedEnvironmentHost()) processes.assertIdle()
  }, false)
  return cases.run(() => supportsSharedEnvironmentHost() ? processes.run(execute) : execute())
}

after(async () => {
  await cases.drain()
  if (!lease) return
  try { await lease.close() } finally { save() }
})
