import type { ArtifactSet } from './artifacts.js'
import { webArtifacts, checkArtifactInstallations } from './artifact-harness.js'
import { checkRoleAgentCapability } from './role-agent-capability.js'
import type { WebHarness } from './web-harness.js'

export interface HostCapabilityEvidence { name: string; sha256: string; adapter: string; checks: readonly string[]; status: 'passed' }
/** Injection boundary for fixture contracts in tests, never exposed as a CLI flag. */
export type HostCapabilityCheck = (context: WebHarness, set: ArtifactSet) => Promise<string>

/** Registered Host-only contracts execute actual capabilities; unknown packages fail closed. */
export const checkHostCapabilities: HostCapabilityCheck = async (context, set) => {
  const evidence: HostCapabilityEvidence[] = []
  for (const pkg of webArtifacts(set).filter(p => !p.client)) {
    if (pkg.name !== '@mbda9091/role-agent') throw new Error(`Host plugin lacks a capability adapter: ${pkg.name}`)
    const checks = await checkRoleAgentCapability(context)
    evidence.push({ name: pkg.name, sha256: pkg.sha256, adapter: 'role-agent-v1', checks, status: 'passed' })
  }
  checkArtifactInstallations(context, set)
  return JSON.stringify(evidence)
}
