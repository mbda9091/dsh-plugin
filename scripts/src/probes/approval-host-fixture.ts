/** Test-only Host driver. No LLM/provider replacement or fabricated human messages.
 * Synthetic assistant advertisements, tool/call and boundaries are explicitly driver-authored;
 * actual tool results and approval pairs come from the mounted DSH services.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalProbeArtifactBinding } from '../commands/approval-host-probe.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-shell'

export const name = 'approval-host-probe'
export const inject = ['agents', 'agentPresets', 'sessionPersistence', 'tools', 'approval', 'sandboxPolicy', 'fs', 'shell']
export interface Config { mode: 'observe' | 'allow'; runDir: string; evidenceDir: string; home: string; artifactBinding?: ApprovalProbeArtifactBinding }
interface ProbeCase { label: string; sessionId: string; callId: string; name: string; result: ToolExecutionResult; outcomes: string[] }

export function apply(ctx: Context, config: Config): void {
  const controller = new AbortController()
  let started = false
  let pending: Promise<void> | undefined
  const interval = setInterval(() => {
    if (started || !existsSync(join(config.evidenceDir, 'start'))) return
    started = true
    clearInterval(interval)
    pending = run(ctx, config, controller.signal)
  }, 100)
  ctx.effect(() => async () => { clearInterval(interval); controller.abort(); await pending })
}

async function run(ctx: Context, config: Config, signal: AbortSignal): Promise<void> {
  const handles: AgentHandle[] = []
  const cases: ProbeCase[] = []
  const evidence: Record<string, unknown> = {
    provenance: 'programmatic-host-probe', llmCalled: false, humanApprovalSimulated: false,
    note: 'Synthetic assistant tool advertisement plus driver-authored tool/call and boundaries; no model output. Real ToolRuntime, ApprovalService, filesystem fence and macOS shell provider. Test fallback rejects; it never impersonates human approval.',
    platform: process.platform, node: process.version, mode: config.mode, cases, ok: false,
    inputKind: config.artifactBinding ? 'fixed-artifact' : 'development-source',
    ...(config.artifactBinding ? { artifactBinding: config.artifactBinding } : {}),
  }
  let disposeFallback: (() => void) | undefined
  try {
    assert.equal(process.platform, 'darwin')
    for (const path of [config.home, config.evidenceDir]) {
      const rel = relative(config.runDir, path)
      assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'probe paths must belong to this isolated run')
    }
    const workspace = join(config.runDir, 'workspace', config.mode)
    const external = join(config.runDir, 'workspace', 'external', config.mode)
    mkdirSync(workspace, { recursive: true }); mkdirSync(external, { recursive: true })
    const grantsFile = join(config.home, 'profiles/web/approval-allowlist', `${config.mode}-grants.json`)
    mkdirSync(join(grantsFile, '..'), { recursive: true })
    // Harness-owned configuration, NOT a management-tool or model-created permission.
    const rules: Record<string, unknown>[] = []
    const save = () => writeFileSync(grantsFile, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`)
    const grant = (id: string, tool: string, args: Record<string, unknown>, scope = 'project') => {
      rules.push({ id, scope, ...(scope === 'project' ? { projectRoot: workspace } : {}), tool,
        ...(typeof args.file_path === 'string' ? { path: args.file_path } : {}), arguments: args })
      save()
    }
    save()
    const create = async (cwd: string) => {
      mkdirSync(cwd, { recursive: true })
      const handle = await ctx.agents.create({ sessionId: SessionId(`programmatic-approval-probe-${randomUUID()}`), meta: { cwd, agentPreset: 'standard' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
      handles.push(handle)
      assert.equal(handle.agent.session.header.cwd, cwd)
      assert.ok(ctx.agents.roots().includes(handle.agent))
      return handle.agent
    }
    const agent = await create(workspace)
    evidence.identity = { header: agent.session.header, root: ctx.agents.roots().includes(agent), standing: ctx.sandboxPolicy.resolve({ session: agent.session }),
      fsSandboxMode: ctx.fs.sandboxMode, shellSandboxMode: ctx.shell.sandboxMode }
    for (const tool of ['write', 'edit', 'bash']) {
      const schema = ctx.tools.get(tool, agent)
      assert.ok(schema, `standard preset lacks ${tool}`)
      assert.match(JSON.stringify(schema.parameters), /sandbox_permissions/, `${tool} is not backed by a confining provider`)
    }
    evidence.schemas = ctx.tools.schemas(agent).filter(s => ['write', 'edit', 'bash'].includes(s.name))
    // Registered after allowlist. Nonmatches go through the real waterfall to an explicit test rejection.
    disposeFallback = ctx.on('approval/request', async (req, next) => handles.some(h => h.agent.id === req.agent.id) ? 'rejected' : next(), { global: true })
    const turns = new Map<string, number>()
    const invoke = async (label: string, owner: Agent, name: string, args: Record<string, unknown>) => {
      signal.throwIfAborted()
      const turn = (turns.get(owner.id) ?? 0) + 1
      turns.set(owner.id, turn)
      const callId = ToolCallId(`programmatic:${label}:${randomUUID()}`)
      const session = owner.session
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      const before = session.ownEvents().length
      try {
        // V4 storage requires an advertised tool lifecycle. This is explicitly synthetic,
        // never attributed to a real model/provider; no adapter is registered or invoked.
        session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
          source: { provider: 'synthetic-host-probe-no-llm', model: 'synthetic-lifecycle-advertisement' },
          content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
        }) }, { surfaceOp: 'append' })
        const call = session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
        const result = await ctx.agents.withInitiator(owner, () => ctx.tools.execute({ callId, name, arguments: args, agent: owner, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }))
        session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
          ...(result.isError && result.error.info ? { error: result.error.info } : {}), ...(result.meta !== undefined ? { meta: result.meta } : {}) },
          { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        const callEvents = session.ownEvents().slice(before)
        const asked = callEvents.filter(e => e.type === 'approval/asked')
        const decided = callEvents.filter(e => e.type === 'approval/decided')
        assert.equal(asked.length, decided.length, 'each approval ask must have exactly one decision')
        for (const request of asked) {
          assert.equal(request.data.callId, callId)
          assert.equal(request.data.toolName, name)
          assert.equal(decided.filter(d => d.data.id === request.data.id).length, 1)
        }
        const outcomes = decided.map(e => e.data.outcome)
        const item = { label, sessionId: owner.id, callId, name, result, outcomes }
        cases.push(item)
        return item
      } finally { session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } }) }
    }
    const ask = { sandbox_permissions: 'danger-full-access', justification: 'Isolated programmatic acceptance probe; touch only this run-owned fixture.' }
    const accepted = (c: ProbeCase) => { assert.deepEqual(c.outcomes, ['allowed-once'], c.label); assert.equal(c.result.isError, false, JSON.stringify(c)) }
    const rejected = (c: ProbeCase) => { assert.deepEqual(c.outcomes, ['rejected'], c.label); assert.equal(c.result.isError, true, JSON.stringify(c)) }
    const file = join(external, 'write.txt')
    const writeArgs = { file_path: file, content: 'before\n', ...ask }
    grant('write-project', 'write', writeArgs)
    const w = await invoke('write-match', agent, 'write', writeArgs)
    if (config.mode === 'observe') rejected(w); else { accepted(w); assert.equal(readFileSync(file, 'utf8'), 'before\n') }

    const editFile = config.mode === 'allow' ? file : join(external, 'edit-observe.txt')
    if (config.mode === 'observe') writeFileSync(editFile, 'before\n') // pre-existing test fixture, never a denied mutation retry
    const read = await invoke('read-before-edit', agent, 'read', { file_path: editFile })
    assert.equal(read.result.isError, false)
    const editArgs = { file_path: editFile, old_string: 'before', new_string: 'after', ...ask }
    grant('edit-project', 'edit', editArgs)
    const e = await invoke('edit-match', agent, 'edit', editArgs)
    if (config.mode === 'observe') rejected(e); else { accepted(e); assert.equal(readFileSync(file, 'utf8'), 'after\n') }

    const shellFile = join(external, 'bash.txt')
    const bashArgs = { description: 'Write isolated acceptance marker file', command: `printf 'bash-probe\\n' > '${shellFile.replaceAll("'", "'\\''")}'`, workdir: workspace, timeoutMs: 5000, ...ask }
    grant('bash-exact', 'bash', bashArgs, 'permanent')
    const b = await invoke('bash-match', agent, 'bash', bashArgs)
    if (config.mode === 'observe') rejected(b); else { accepted(b); assert.equal(readFileSync(shellFile, 'utf8'), 'bash-probe\n') }

    if (config.mode === 'allow') {
      const missPath = join(external, 'unmatched.txt')
      rejected(await invoke('unmatched', agent, 'write', { ...writeArgs, file_path: missPath }))
      assert.equal(existsSync(missPath), false)
      const revokedPath = join(external, 'revoked.txt')
      const revokedArgs = { ...writeArgs, file_path: revokedPath }
      grant('revoke-test', 'write', revokedArgs)
      // Direct user-owned file revocation, no management authorization is simulated.
      rules.splice(rules.findIndex(rule => rule.id === 'revoke-test'), 1); save()
      rejected(await invoke('revoked', agent, 'write', revokedArgs))
      assert.equal(existsSync(revokedPath), false)
      const other = await create(join(config.runDir, 'workspace/other-project'))
      const projectPath = join(external, 'other-project.txt')
      const projectArgs = { ...writeArgs, file_path: projectPath }
      grant('project-mismatch', 'write', projectArgs)
      rejected(await invoke('project-mismatch', other, 'write', projectArgs))
      assert.equal(existsSync(projectPath), false)
      const permanentPath = join(external, 'permanent-other-project.txt')
      const permanentArgs = { ...writeArgs, file_path: permanentPath }
      grant('permanent-other-project', 'write', permanentArgs, 'permanent')
      accepted(await invoke('permanent-other-project', other, 'write', permanentArgs))
      assert.equal(readFileSync(permanentPath, 'utf8'), 'before\n')

      // Separate negative cases, each with a new run-owned target, never retries after rejection.
      for (const changed of ['command', 'workdir', 'sandbox_permissions'] as const) {
        const path = join(external, `bash-mismatch-${changed}.txt`)
        const exact = { ...bashArgs, command: `printf 'exact\\n' > '${path}'` }
        grant(`bash-mismatch-${changed}`, 'bash', exact, 'permanent')
        const altered = { ...exact, ...(changed === 'command' ? { command: `printf 'different\\n' > '${path}'` }
          : changed === 'workdir' ? { workdir: other.session.header.cwd! } : { sandbox_permissions: 'workspace-write' }) }
        rejected(await invoke(`bash-mismatch-${changed}`, agent, 'bash', altered))
        assert.equal(existsSync(path), false)
      }
      const list = await invoke('management-list', agent, 'approval_list', {})
      assert.equal(list.result.isError, false, JSON.stringify(list))
      const beforeManagement = readFileSync(grantsFile, 'utf8')
      const managementPath = join(external, 'management-denied.txt')
      rejected(await invoke('management-allow-rejected', agent, 'approval_allow', { rule: JSON.stringify({
        scope: 'project', projectRoot: workspace, tool: 'write', path: managementPath,
        arguments: { ...writeArgs, file_path: managementPath },
      }) }))
      assert.equal(readFileSync(grantsFile, 'utf8'), beforeManagement, 'rejected management must not persist a grant')
      // The approved workspace-write call still cannot mutate a sibling directory.
      const deniedPath = join(external, 'provider-denied.txt')
      const deniedArgs = { file_path: deniedPath, content: 'must-not-exist', sandbox_permissions: 'workspace-write', justification: 'Verify provider fence remains authoritative after one-shot approval.' }
      grant('provider-denial', 'write', deniedArgs)
      const denied = await invoke('approved-but-provider-denied', agent, 'write', deniedArgs)
      assert.deepEqual(denied.outcomes, ['allowed-once'])
      assert.equal(denied.result.isError, true)
      if (denied.result.isError) assert.equal(denied.result.error.info?.code, 'FS_SANDBOX_DENIED')
      assert.match(JSON.stringify(denied.result.content), /\[sandbox: file access denied under workspace-write mode\]/)
      assert.equal(existsSync(deniedPath), false)
      // No retry of the denied operation. Standing policy remains unchanged.
      assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only')
    }
    evidence.ok = true
  } catch (error) {
    evidence.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  } finally {
    // Flush then read through the real storage handle: in-memory observation alone is insufficient.
    try {
      await ctx.sessionPersistence.flush()
      for (const handle of handles) {
        const stored = await ctx.sessionPersistence.open(handle.agent.id, 'read')
        try {
          const { events } = await stored.read()
          assert.deepEqual(events, handle.agent.session.ownEvents(), 'persistent event readback differs')
          assert.deepEqual(stored.header, { ...handle.agent.session.header, delegationDepth: handle.agent.session.header.delegationDepth ?? 0 }, 'storage defaults delegationDepth to zero')
          writeFileSync(join(config.evidenceDir, `${handle.agent.id}.json`), JSON.stringify({ provenance: 'programmatic-host-probe', ...(config.artifactBinding ? { artifactBinding: config.artifactBinding } : {}), header: stored.header, events }, null, 2))
        } finally { await stored.close() }
      }
      evidence.persistedReadback = true
    } catch (error) { evidence.ok = false; evidence.persistenceError = String(error) }
    disposeFallback?.()
    for (const handle of handles) { try { await handle.dispose() } catch (error) { evidence.ok = false; evidence.disposeError = String(error) } }
    writeFileSync(join(config.evidenceDir, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  }
}
