import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRecord } from './json.js'
import { runToFilesAsync } from './exec.js'
import type { ArtifactSet } from './artifacts.js'
import { checkInstalledPackage } from './artifact-package.js'
import { webArtifacts, checkArtifactInstallations } from './artifact-harness.js'
import { childEnv } from './web-harness.js'
import type { WebHarness } from './web-harness.js'

export const approvalCapabilityChecks = ['registration', 'observe', 'exact-match', 'mismatch', 'max-uses', 'root-scope', 'audit'] as const
export interface HostCapabilityEvidence { name: string; sha256: string; adapter: string; checks: readonly string[]; status: 'passed' }
/** Injection boundary for fixture contracts in tests, never exposed as a CLI flag. */
export type HostCapabilityCheck = (context: WebHarness, set: ArtifactSet) => Promise<string>
interface ContractContext {
  get(name: string): unknown
  on(event: string, handler: (...args: unknown[]) => unknown, options: unknown): () => void
}

/** Shared behavioral contract, exercised against both source-build and tarball modules.
 * Uses committed tool/call-shaped events and invokes the registered waterfall;
 * no real shell command, model credential, or approval is involved. */
export async function checkApprovalCapability(plugin: unknown, directory: string): Promise<void> {
  assert.ok(isRecord(plugin) && typeof plugin.apply === 'function', 'missing Host apply')
  const apply = plugin.apply as (ctx: ContractContext, config: { mode?: 'allow' | 'observe'; logFile: string; rules: { tool: string; arguments: { command: string }; maxUses?: number }[] }) => void
  const root = { session: { ownEvents: () => [
    { type: 'tool/call', data: { callId: 'match', name: 'pwsh', arguments: '{"command":"expected"}' } },
    { type: 'tool/call', data: { callId: 'different', name: 'pwsh', arguments: '{"command":"different"}' } },
    { type: 'tool/call', data: { callId: 'tool', name: 'other', arguments: '{"command":"expected"}' } },
  ] } }
  const sub = { session: root.session }
  for (const mode of ['observe', 'allow'] as const) {
    const listeners: { event: string; handler: (...args: unknown[]) => unknown; options: unknown }[] = []
    const services: Record<string, unknown> = { profileContext: { startedBundles: ['@deepseek-ai/dsh-web-app'] }, agents: { roots: () => [root] } }
    const ctx = { get: (name: string) => services[name], on: (event: string, handler: (...args: unknown[]) => unknown, options: unknown) => { listeners.push({ event, handler, options }); return () => {} } }
    const logFile = join(directory, `approval-${mode}.jsonl`)
    apply(ctx, { ...(mode === 'allow' ? { mode } : {}), logFile, rules: [{ tool: 'pwsh', arguments: { command: 'expected' }, maxUses: 1 }] })
    const listener = listeners.find(l => l.event === 'approval/request')
    assert.ok(listener, 'apply must register approval/request')
    assert.deepEqual(listener.options, { global: true })
    const invoke = (callId: string | undefined, agent = root) => listener.handler({ agent, callId, toolName: 'pwsh', reason: 'capability contract' }, async () => 'next')
    assert.equal(await invoke('match', sub), 'next', 'subagent must not receive root grants')
    for (const callId of ['different', 'tool', 'missing', undefined]) assert.equal(await invoke(callId), 'next', 'nonmatches must continue normal approval')
    assert.equal(await invoke('match'), mode === 'allow' ? 'allowed-once' : 'next')
    assert.equal(await invoke('match'), 'next', 'observe never grants; allow respects maxUses')
    const records = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.length, 7)
    assert.equal(records[5].decision, mode === 'allow' ? 'allow' : 'observe')
    assert.equal(records[5].arguments, '{"command":"expected"}')
  }
}

export const checkHostCapabilities: HostCapabilityCheck = async (context, set) => {
  const evidence: HostCapabilityEvidence[] = []
  for (const pkg of webArtifacts(set).filter(p => !p.client)) {
    if (pkg.name !== '@local/approval-allowlist') throw new Error(`Host plugin lacks a capability adapter: ${pkg.name}`)
    const content = set.packages.get(pkg.name)!
    const actual = checkInstalledPackage(content, join(context.home, 'profiles/web'), set.root)
    const script = `import {checkApprovalCapability} from ${JSON.stringify(import.meta.url)}; await checkApprovalCapability(await import(${JSON.stringify(pathToFileURL(join(actual, content.entry)).href)}), ${JSON.stringify(context.runDir)});`
    const result = await runToFilesAsync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: context.runDir, env: childEnv(context, context.home), signal: context.signal, timeoutMs: context.options.timeoutMs,
      stdoutPath: join(context.logDir, 'host-capability.out'), stderrPath: join(context.logDir, 'host-capability.err'),
    })
    if (result.status !== 0 || result.timedOut) throw new Error(`Host capability failed: ${pkg.name}\n${result.stderr}`)
    evidence.push({ name: pkg.name, sha256: pkg.sha256, adapter: 'approval-allowlist-v1', checks: approvalCapabilityChecks, status: 'passed' })
  }
  checkArtifactInstallations(context, set)
  return JSON.stringify(evidence)
}
