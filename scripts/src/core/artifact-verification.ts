import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactSet } from './artifacts.js'
import { assertArtifactsUnchanged } from './artifacts.js'
import { isRecord } from './json.js'
import type { TestReport } from './test-run.js'
import type { Target } from './targets.js'
import { approvalCapabilityChecks } from './host-capability.js'

export const artifactSteps = {
  l4: ['context', 'package-contracts', 'profile-init', 'install-artifacts', 'host-capabilities', 'web-artifacts', 'cleanup'],
  l5: ['context', 'package-contracts', 'compile-browser', 'prerequisites', 'profile-init', 'baseline', 'install-artifacts', 'fixture', 'cleanup'],
} as const
export interface Verification {
  version: 1; batch: string; manifestSha256: string; sourceSha256: string
  startedAt: string; finishedAt: string; status: 'passed' | 'failed'; failure?: string
  tools: { node: string; pnpm: string; dsh: string }; platform: string; surface: 'web'
  contracts: { name: string; sha256: string; status: 'passed' }[]
  environment: { kind: string; steps: string[]; cleanup: string }[]
  functions: { l4?: TestReport; l5?: TestReport; browser?: { baseline: unknown; fixture: unknown } }
  coverage: { name: string; sha256: string; surface: string; platform: string; host: string; status: 'passed' | 'uncovered'; reason: string }[]
}
export function validateArtifactReport(report: unknown, kind: 'l4' | 'l5', set: ArtifactSet, startedAt: string): asserts report is TestReport {
  const expected = artifactSteps[kind]
  if (!isRecord(report) || report.version !== 1 || report.kind !== kind || report.ok !== true || typeof report.startedAt !== 'string' || report.startedAt < startedAt
    || !Number.isFinite(Date.parse(report.startedAt)) || typeof report.finishedAt !== 'string' || !Number.isFinite(Date.parse(report.finishedAt)) || report.finishedAt < report.startedAt || !Array.isArray(report.steps) || report.steps.length !== expected.length
    || report.steps.some((s, i) => !isRecord(s) || s.name !== expected[i] || s.ok !== true)
    || typeof report.cleanup !== 'string' || !/^(removed|retained --keep)/.test(report.cleanup)) throw new Error(`incomplete/failed artifact ${kind} results`)
  const contract = report.steps.find(s => isRecord(s) && s.name === 'package-contracts')
  if (!isRecord(contract) || typeof contract.detail !== 'string' || !contract.detail.includes(set.hash)) throw new Error('functional report is not bound to artifact hash')
  const installed = report.steps.find(s => isRecord(s) && s.name === 'install-artifacts')
  if (!isRecord(installed) || typeof installed.detail !== 'string') throw new Error('missing installation hash evidence')
  const evidence: unknown = JSON.parse(installed.detail)
  const selected = set.manifest.packages.filter(p => p.surfaces.includes('web') && p.platforms.includes(report.platform === 'win32' ? 'windows' : 'mac'))
  if (!Array.isArray(evidence) || evidence.length !== selected.length || selected.some(p => evidence.filter(e => isRecord(e) && e.name === p.name && e.sha256 === p.sha256 && typeof e.actual === 'string').length !== 1)) throw new Error('incomplete installation hash evidence')
  if (kind === 'l4') {
    const step = report.steps.find(s => isRecord(s) && s.name === 'host-capabilities')
    const results: unknown = isRecord(step) && typeof step.detail === 'string' ? JSON.parse(step.detail) : null
    const hosts = selected.filter(p => !p.client)
    if (!Array.isArray(results) || results.length !== hosts.length || hosts.some(p => results.filter(r => isRecord(r)
      && r.name === p.name && r.sha256 === p.sha256 && r.status === 'passed' && typeof r.adapter === 'string' && r.adapter.length > 0
      && Array.isArray(r.checks) && r.checks.length > 0 && new Set(r.checks).size === r.checks.length && r.checks.every((c: unknown) => typeof c === 'string' && c.length > 0)
      && (p.name !== '@local/approval-allowlist' || r.adapter === 'approval-allowlist-v1' && JSON.stringify(r.checks) === JSON.stringify(approvalCapabilityChecks))).length !== 1)) throw new Error('incomplete Host capability evidence')
  }
}
export function validateVerification(set: ArtifactSet, value: unknown, target: Target, host: string, names: readonly string[]): asserts value is Verification {
  assertArtifactsUnchanged(set)
  if (!isRecord(value) || value.version !== 1 || value.status !== 'passed' || value.batch !== set.manifest.batch || value.manifestSha256 !== set.hash || value.sourceSha256 !== set.manifest.source.sha256
    || typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || Date.parse(value.finishedAt) < Date.parse(value.startedAt) || !Number.isFinite(Date.parse(value.finishedAt))
    || !isRecord(value.tools) || typeof value.tools.node !== 'string' || !/^v24\./.test(value.tools.node) || value.tools.pnpm !== set.manifest.tools.pnpm || value.tools.dsh !== host
    || value.surface !== target.surface || value.platform !== target.platform || !Array.isArray(value.coverage) || !Array.isArray(value.contracts) || !Array.isArray(value.environment) || !isRecord(value.functions)) throw new Error('missing, stale, future or incompatible artifact verification')
  const contracts = value.contracts, environment = value.environment
  if (contracts.length !== set.manifest.packages.length || set.manifest.packages.some(p => contracts.filter((c: unknown) => isRecord(c) && c.name === p.name && c.sha256 === p.sha256 && c.status === 'passed').length !== 1)) throw new Error('incomplete package contract results')
  validateArtifactReport(value.functions.l4, 'l4', set, value.startedAt)
  const kinds = ['l4']
  if (set.manifest.packages.some(p => p.client && p.surfaces.includes('web') && p.platforms.includes(target.platform))) {
    kinds.push('l5'); validateArtifactReport(value.functions.l5, 'l5', set, value.startedAt)
    const browser = value.functions.browser
    for (const mode of ['baseline', 'fixture'] as const) {
      const expected = mode === 'baseline' ? ['no-custom-plugins'] : ['slot-interaction-theme-locale-reload', 'notification-en', 'notification-zh', 'notification-denied']
      const results: unknown = isRecord(browser) ? browser[mode] : undefined
      if (!Array.isArray(results) || results.length !== expected.length || results.some((r, i) => !isRecord(r) || r.name !== expected[i] || r.ok !== true)) throw new Error('incomplete artifact browser evidence')
    }
  }
  if (environment.length !== kinds.length || kinds.some(kind => environment.filter((e: unknown) => isRecord(e) && e.kind === kind && typeof e.cleanup === 'string' && /^(removed|retained --keep)/.test(e.cleanup) && JSON.stringify(e.steps) === JSON.stringify(['context', 'profile-init', 'install-artifacts', 'cleanup'])).length !== 1)) throw new Error('incomplete artifact environment evidence')
  for (const report of [value.functions.l4, value.functions.l5]) if (isRecord(report)
    && (report.platform !== (target.platform === 'windows' ? 'win32' : 'darwin') || report.node !== value.tools.node || typeof report.finishedAt !== 'string' || report.finishedAt > value.finishedAt)) throw new Error('functional evidence platform/tool/time mismatch')
  const coverage = value.coverage
  const scopes = set.manifest.packages.flatMap(p => p.surfaces.flatMap(surface => p.platforms.map(platform => ({ name: p.name, sha256: p.sha256, surface, platform }))))
  if (coverage.length !== scopes.length || scopes.some(scope => coverage.filter(c => isRecord(c) && c.name === scope.name && c.sha256 === scope.sha256 && c.surface === scope.surface && c.platform === scope.platform && c.host === host
    && c.status === (scope.surface === 'web' && scope.platform === target.platform ? 'passed' : 'uncovered') && typeof c.reason === 'string' && c.reason.length > 0).length !== 1)) throw new Error('incomplete or incorrectly claimed coverage')
  for (const name of names) {
    const pkg = set.manifest.packages.find(p => p.name === name)
    if (!pkg || !pkg.surfaces.includes(target.surface) || !pkg.platforms.includes(target.platform)
      || value.coverage.filter((c: unknown) => isRecord(c) && c.name === name && c.sha256 === pkg.sha256 && c.surface === target.surface && c.platform === target.platform && c.host === host && c.status === 'passed').length !== 1) throw new Error(`uncovered artifact target/host: ${name} ${target.surface}/${target.platform} ${host}`)
  }
}
export function verificationPath(set: ArtifactSet, platform: string): string { return join(set.root, 'dist/verification', set.manifest.batch, `web-${platform}.json`) }
export function readVerification(set: ArtifactSet, target: Target, host: string, names: readonly string[]): Verification {
  const value: unknown = JSON.parse(readFileSync(verificationPath(set, target.platform), 'utf8'))
  validateVerification(set, value, target, host, names); return value
}
