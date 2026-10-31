import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { artifactLock, assertArtifactsUnchanged, loadArtifacts } from '../core/artifacts.js'
import type { CommandContext } from '../core/command-context.js'
import { safeConfigPath } from '../core/config-transaction.js'
import { expectedPnpm, workspaceDsh } from '../core/toolchain.js'
import { resolveTarget } from '../core/targets.js'
import { validateArtifactReport, validateVerification, verificationPath } from '../core/artifact-verification.js'
import type { Verification } from '../core/artifact-verification.js'
import { runL4 } from './l4.js'
import { runL5 } from './l5.js'

export async function runVerifyArtifacts(input: { manifest: string; keep: boolean; check?: boolean }, settings: CommandContext): Promise<number> {
  const release = artifactLock(settings.root)
  try {
    const artifacts = loadArtifacts(settings.root, input.manifest), target = resolveTarget({ surface: 'web' }), host = workspaceDsh(settings.root).version
    const path = verificationPath(artifacts, target.platform)
    const selected = artifacts.manifest.packages.filter(p => p.surfaces.includes('web') && p.platforms.includes(target.platform))
    if (input.check) {
      validateVerification(artifacts, JSON.parse(readFileSync(path, 'utf8')), target, host, selected.map(p => p.name))
      console.log(`valid verification: ${path}`); return 0
    }
    safeConfigPath(settings.root, path); mkdirSync(dirname(path), { recursive: true })
    // A rerun invalidates the old success before any host operation.
    const record: Verification = { version: 1, batch: artifacts.manifest.batch, manifestSha256: artifacts.hash, sourceSha256: artifacts.manifest.source.sha256,
      startedAt: new Date().toISOString(), finishedAt: '', status: 'failed', tools: { node: process.version, pnpm: expectedPnpm(settings.root), dsh: host },
      platform: target.platform, surface: 'web', contracts: [], environment: [], functions: {}, coverage: [] }
    writeFileSync(path, JSON.stringify(record, null, 2))
    try {
      if (!selected.length) throw new Error('no artifacts applicable to this Web platform')
      const options = { keep: input.keep, artifacts }
      const l4 = await runL4({ ...options, skipTarball: false }, settings, report => { record.functions.l4 = report })
      if (l4 !== 0) throw new Error('artifact L4 failed')
      validateArtifactReport(record.functions.l4, 'l4', artifacts, record.startedAt)
      record.contracts = artifacts.manifest.packages.map(p => ({ name: p.name, sha256: p.sha256, status: 'passed' }))
      if (selected.some(p => p.client)) {
        if (selected.some(p => p.client && p.name !== '@local/notify-web')) throw new Error('client plugin lacks an artifact L5 adapter')
        const l5 = await runL5(options, settings, report => { record.functions.l5 = report })
        if (l5 !== 0) throw new Error('artifact L5 failed')
        validateArtifactReport(record.functions.l5, 'l5', artifacts, record.startedAt)
        record.functions.browser = {
          baseline: JSON.parse(readFileSync(join(record.functions.l5.runDir, 'artifacts/baseline/results.json'), 'utf8')),
          fixture: JSON.parse(readFileSync(join(record.functions.l5.runDir, 'artifacts/fixture/results.json'), 'utf8')),
        }
      }
      for (const report of [record.functions.l4, record.functions.l5]) if (report) record.environment.push({ kind: report.kind, cleanup: report.cleanup, steps: ['context', 'profile-init', 'install-artifacts', 'cleanup'] })
      record.coverage = artifacts.manifest.packages.flatMap(p => p.surfaces.flatMap(surface => p.platforms.map(platform => ({ name: p.name, sha256: p.sha256, surface, platform, host,
        status: surface === 'web' && platform === target.platform ? 'passed' as const : 'uncovered' as const,
        reason: surface === 'web' && platform === target.platform ? 'package contracts, isolated install, L4 and applicable L5' : 'not executed: requires corresponding host/platform and native capability evidence' }))))
      assertArtifactsUnchanged(artifacts); record.status = 'passed'; record.finishedAt = new Date().toISOString()
      validateVerification(artifacts, record, target, host, selected.map(p => p.name))
      return 0
    } catch (error) {
      record.status = 'failed'; record.failure = error instanceof Error ? error.message : String(error)
      console.error(record.failure); return 1
    } finally {
      record.finishedAt = new Date().toISOString(); writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
      console.log(`artifact verification: ${path}`)
    }
  } finally { release() }
}
