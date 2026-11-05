import type { ArtifactSet } from './artifacts.js'
import { webArtifacts, checkArtifactInstallations } from './artifact-harness.js'
import type { WebHarness } from './web-harness.js'

export interface HostCapabilityEvidence { name: string; sha256: string; adapter: string; checks: readonly string[]; status: 'passed' }
/** Injection boundary for fixture contracts in tests, never exposed as a CLI flag. */
export type HostCapabilityCheck = (context: WebHarness, set: ArtifactSet) => Promise<string>

/** No Web Host-only adapters are currently registered. Unknown packages fail closed. */
export const checkHostCapabilities: HostCapabilityCheck = async (context, set) => {
  for (const pkg of webArtifacts(set).filter(p => !p.client)) {
    throw new Error(`Host plugin lacks a capability adapter: ${pkg.name}`)
  }
  checkArtifactInstallations(context, set)
  return JSON.stringify([] satisfies HostCapabilityEvidence[])
}
