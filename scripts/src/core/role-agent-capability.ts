import { join } from 'node:path'
import { repoRoot } from './repo.js'
import { runDsh, serveAndCheck } from './web-harness.js'
import type { WebHarness } from './web-harness.js'
import { isRecord } from './json.js'
import { writeFileSync, readFileSync } from 'node:fs'

/** Actual DSH scope/capability proof, only installed in the disposable harness. */
export async function checkRoleAgentCapability(context: WebHarness): Promise<readonly string[]> {
  await runDsh(context, 'install-role-contract', ['plugin', '--profile', 'web', 'add', join(repoRoot, 'test/fixtures/role-agent-contract')], context.home)
  const required = ['dedicated-preset', 'scoped-persona', 'scoped-context', 'four-role-tools', 'ordinary-mode-unchanged', 'subagent-excluded', 'durable-binding', 'synthetic-model-only', 'real-tool-execution-unavailable-not-empty', 'runtime-context-deduplicated', 'durable-conversation-log', 'blank-mode-switch-in-and-out']
  required.push('standard-tool-parity','standard-schema-parity','no-delegation-tools','native-files-search-shell','native-web-provider-contract','native-jobs-schedule','native-skill-todo-goal-present-question','native-plan-isolation')
  const previousPatch = context.webPatch
  const patch = join(context.runDir, 'role-m5-contract.patch.yml')
  writeFileSync(patch, (previousPatch ? readFileSync(previousPatch, 'utf8')+'\n' : '') + "- id: web\n  config:\n    searchProvider: m5-test\n    fetchProvider: m5-test\n- id: role-agent-contract\n  config:\n    m5Proof: true\n")
  context.webPatch = patch
  let checks: string[] | undefined
  try { await serveAndCheck(context, 'role-agent-capability', async (url, stderr) => {
    if (/entry did not activate/.test(stderr)) throw new Error('Role capability fixture did not activate')
    const signal = AbortSignal.timeout(105000)
    const first = await fetch(url, { redirect: 'manual', signal })
    const cookie = first.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
    const page = new URL(first.headers.get('location') ?? url, url)
    await first.body?.cancel()
    const response = await fetch(new URL('api/role-agent-contract', page), { method: 'POST', headers: { cookie }, signal })
    const value: unknown = await response.json()
    if (!response.ok || !isRecord(value) || value['status'] !== 'passed' || !Array.isArray(value['checks']) || value['checks'].length !== required.length || !required.every(check => (value as { checks: unknown[] }).checks.includes(check))) throw new Error(`Role capability contract failed: ${JSON.stringify(value)}`)
    if (!value['checks'].every((v): v is string => typeof v === 'string')) throw new Error('Invalid role evidence')
    checks = value['checks']
    return JSON.stringify(checks)
  }) } finally { context.webPatch = previousPatch }
  if (!checks) throw new Error('Missing role capability evidence')
  return checks
}
