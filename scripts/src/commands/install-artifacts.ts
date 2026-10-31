import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { artifactLock, assertArtifactsUnchanged, assertConsumed, copyArtifact, loadArtifacts } from '../core/artifacts.js'
import { checkInstalledPackage } from '../core/artifact-package.js'
import { readVerification } from '../core/artifact-verification.js'
import { configuredPnpm, commandEnv, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { runToFilesAsync } from '../core/exec.js'
import { writePnpmShim } from '../core/pnpm.js'
import { resolveTarget, isTargetCompatible } from '../core/targets.js'
import { digest, safeConfigPath } from '../core/config-transaction.js'
import { inspectTarget } from '../core/formal-target.js'
import { redactLaunchTokens } from '../core/web-harness.js'
import type { InstallOptions } from './install.js'
import { parseDocument } from 'yaml'
import { isRecord } from '../core/json.js'

export interface DeliveryPackage {
  name: string; sha256: string; selected: boolean; reason: string
  status: 'skipped' | 'not-attempted' | 'installing' | 'installed' | 'failed'
  stage: string; archive?: string; actual?: string; spec?: string
  bundle: 'unconfirmed' | 'registered'; loaded: 'unconfirmed' | 'restart-required' | 'failed'
  row: 'unconfirmed' | 'configured' | 'failed'
  capability: 'unverified'; warnings: string[]; error?: string
}
export interface DeliveryReport {
  version: 1; batch: string; manifestSha256: string; startedAt: string; finishedAt?: string
  status: 'installing' | 'installed' | 'needs-attention' | 'failed'; target: ReturnType<typeof inspectTarget>['target']
  identity: ReturnType<typeof inspectTarget>['identity']; host: string; packages: DeliveryPackage[]; error?: string
  packageConfiguration: 'system'
}

/** CLI output is diagnostics, never positive evidence of runtime activation. */
export function deliveryDiagnostics(output: string): { warnings: string[]; loaded: DeliveryPackage['loaded'] } {
  const text = redactLaunchTokens(output).replace(/\u001b\[[0-9;]*m/g, '')
  return { warnings: text.split(/\r?\n/).filter(line => /\bwarn(?:ing)?s?\b/i.test(line) && !/warnings\s*[:=]\s*\[\s*\]/i.test(line)),
    loaded: /(?:slot entry crashed|load(?:ing)?[- ]failed|application\s*[:=]\s*failed|status\s*[:=]\s*(?:failed|overridden))/i.test(text) ? 'failed'
      : /restart-required/i.test(text) ? 'restart-required' : 'unconfirmed' }
}

export function checkDeliveryRow(output: string, name: string): void {
  const doc = parseDocument(output)
  if (doc.errors.length) throw new Error('cannot parse composed target rows')
  const rows: Record<string, unknown>[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (isRecord(value)) {
      if (value.id === name.slice(7)) rows.push(value)
      if (Array.isArray(value.group)) visit(value.group)
    }
  }
  visit(doc.toJS())
  if (rows.length !== 1 || rows[0]!.name !== name || (rows[0]!.disabled !== undefined && rows[0]!.disabled !== false)) throw new Error(`target row missing, overridden or disabled: ${name}`)
}

/** Preflight all selected packages before the first target write. Never repack. */
export async function runArtifactInstall(options: InstallOptions, context: CommandContext, onReport?: (path: string) => void): Promise<number> {
  if (context.purpose !== 'target' || !options.manifest) throw new Error('stable-install requires an explicit target and --manifest; run pack then verify-artifacts')
  if (options.all) throw new Error('--all cannot bypass artifact target coverage')
  const configPath = join(context.root, 'scripts/config/local.json')
  const configHash = existsSync(configPath) ? digest(readFileSync(configPath)) : null
  if (context.target && context.target.name !== 'explicit') {
    const current = loadCommandContext({ target: context.target.name }, context.root, context.env, 'target')
    if (JSON.stringify(current.target) !== JSON.stringify(context.target)) throw new Error('named target configuration changed; preview again')
  }
  const initial = inspectTarget(context), release = artifactLock(context.root)
  try {
    const set = loadArtifacts(context.root, options.manifest), target = resolveTarget(initial.target)
    const names = options.only?.split(',')
    if (names && (!names.length || new Set(names).size !== names.length || names.some(name => !set.packages.has(name)))) throw new Error('--only must contain unique package names from the manifest')
    const selected = set.manifest.packages.filter(p => names ? names.includes(p.name) : isTargetCompatible(p, target))
    if (!selected.length) throw new Error('no compatible artifacts')
    if (selected.some(p => !isTargetCompatible(p, target))) throw new Error('selected artifact is incompatible with target surface/platform')
    const { runner, directory } = initial, pnpm = configuredPnpm(context)
    const base = join(context.root, 'dist/consumption'); safeConfigPath(context.root, base); mkdirSync(base, { recursive: true })
    const scratch = mkdtempSync(join(base, 'run-'))
    writePnpmShim(scratch, pnpm)
    const env = { ...commandEnv(context), ...runner.env }
    for (const key of Object.keys(env)) if (/^DSH_/i.test(key)) delete env[key]
    env.DSH_HOME = initial.target.home; env.DSH_PROFILE = initial.target.profile; env.DSH_PROFILE_DIR = directory
    env.PATH = `${scratch}${delimiter}${env.PATH ?? ''}`
    const version = await runToFilesAsync(runner.command, runner.build(['--version']), { cwd: scratch,
      env: { ...env, DSH_HOME: join(scratch, 'probe-home'), DSH_PROFILE_DIR: join(scratch, 'probe-home/profiles', initial.target.profile) },
      verbatim: runner.verbatim, timeoutMs: 30_000, stdoutPath: join(scratch, 'version.out'), stderrPath: join(scratch, 'version.err') })
    const host = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(version.stdout.trim())?.[0]
    if (version.status !== 0 || !host) throw new Error('cannot determine selected target DSH version')
    const evidence = readVerification(set, target, host, selected.map(p => p.name))
    const packages: DeliveryPackage[] = set.manifest.packages.map(p => ({ name: p.name, sha256: p.sha256, selected: selected.includes(p),
      reason: selected.includes(p) ? 'selected' : isTargetCompatible(p, target) ? 'not selected by --only' : 'incompatible surface/platform',
      status: selected.includes(p) ? 'not-attempted' : 'skipped', stage: 'preflight', bundle: 'unconfirmed', row: 'unconfirmed', loaded: 'unconfirmed', capability: 'unverified', warnings: [] }))
    console.log(JSON.stringify({ target: initial.target, identity: initial.identity, host, manifest: set.path, manifestSha256: set.hash,
      coverage: evidence.coverage.filter(c => selected.some(p => p.name === c.name)),
      packages: packages.map(p => ({ ...p, path: join(dirname(set.path), set.manifest.packages.find(a => a.name === p.name)!.path), operations: p.selected ? ['dsh plugin add', 'pnpm update', 'verify spec/path/content/bundle'] : [] })),
      inputsAndLogs: scratch, packageConfiguration: 'system', dryRun: options.dryRun }, null, 2))
    if (options.dryRun) return 0
    const report: DeliveryReport = { version: 1, batch: set.manifest.batch, manifestSha256: set.hash, startedAt: new Date().toISOString(), status: 'installing', target: initial.target, identity: initial.identity, host, packageConfiguration: 'system', packages }
    const reportPath = join(scratch, 'report.json'), candidate = join(scratch, 'report.next.json')
    const save = () => { safeConfigPath(context.root, reportPath); writeFileSync(candidate, JSON.stringify(report, null, 2) + '\n'); renameSync(candidate, reportPath) }
    const recheck = () => {
      if ((existsSync(configPath) ? digest(readFileSync(configPath)) : null) !== configHash) throw new Error('configuration changed during delivery; preview again')
      const next = inspectTarget(context)
      if (JSON.stringify(next.identity) !== JSON.stringify(initial.identity)) throw new Error('target real paths changed during delivery')
      assertArtifactsUnchanged(set); readVerification(set, target, host, selected.map(p => p.name))
    }
    save(); onReport?.(reportPath)
    let active: DeliveryPackage | undefined
    try {
      for (const p of selected) packages.find(r => r.name === p.name)!.archive = copyArtifact(set, p, join(scratch, 'inputs', p.path))
      save()
      for (const [index, p] of selected.entries()) {
        active = packages.find(r => r.name === p.name)!
        recheck(); active.status = 'installing'; active.stage = 'add'; save()
        const execute = async (stage: string, command: string, args: string[], cwd: string) => {
          recheck(); active!.stage = stage; save()
          const result = await runToFilesAsync(command, args, { cwd, env, timeoutMs: 120_000,
            stdoutPath: join(scratch, `${index}-${stage}.out`), stderrPath: join(scratch, `${index}-${stage}.err`) })
          const diagnostic = deliveryDiagnostics(result.stdout + '\n' + result.stderr)
          active!.warnings.push(...diagnostic.warnings)
          if (active!.loaded !== 'failed' && diagnostic.loaded !== 'unconfirmed') active!.loaded = diagnostic.loaded
          assertConsumed(set, p, active!.archive!)
          if (result.status !== 0 || result.timedOut) throw new Error(`${stage} failed (${result.status}); inspect ${scratch}`)
          return result
        }
        await execute('add', runner.command, runner.build(['plugin', '--profile', initial.target.profile, 'add', active.archive!]), scratch)
        await execute('update', process.execPath, [pnpm, 'update', p.name], directory)
        recheck(); active.stage = 'verify-files'; save()
        active.actual = checkInstalledPackage(set.packages.get(p.name)!, directory, context.root)
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        const spec: string = manifest.dependencies[p.name]
        active.spec = spec
        if (!spec.startsWith('file:') || resolve(directory, spec.slice(5)) !== active.archive) throw new Error(`dependency spec does not reference delivered snapshot: ${p.name}`)
        active.bundle = 'registered'; active.status = 'installed'; active.stage = 'complete'; save()
        if (target.surface === 'web') {
          const composed = await execute('rows', runner.command, runner.build(['--profile', initial.target.profile, '--dump-config']), scratch)
          try { checkDeliveryRow(composed.stdout, p.name); active.row = 'configured' }
          catch (error) { active.row = 'failed'; throw error }
          active.stage = 'complete'; save()
        }
        if (active.loaded === 'failed') throw new Error(`host reported loading failure: ${p.name}`)
      }
      recheck()
      report.status = packages.some(p => p.warnings.length || p.loaded === 'failed') ? 'needs-attention' : 'installed'
    } catch (error) {
      const message = redactLaunchTokens(error instanceof Error ? error.message : 'delivery failed')
      if (active) { if (active.status !== 'installed') active.status = 'failed'; active.error = message }
      report.error = message; report.status = 'failed'
    } finally {
      report.finishedAt = new Date().toISOString(); save()
      console.log(`delivery report: ${reportPath}\n${report.status}; runtime rows/loading unconfirmed unless diagnostics report failure/restart; capability unverified. No automatic restart or rollback.`)
    }
    return report.status === 'installed' ? 0 : 1
  } finally { release() }
}
