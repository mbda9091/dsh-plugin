import { join } from 'node:path'
import { assertArtifactsUnchanged, assertConsumed, copyArtifact } from './artifacts.js'
import type { ArtifactSet } from './artifacts.js'
import { checkInstalledPackage, checkPackageImports } from './artifact-package.js'
import { ensurePnpmShim, runDsh } from './web-harness.js'
import type { WebHarness } from './web-harness.js'
import { resolveTarget, isTargetCompatible } from './targets.js'

export function webArtifacts(set: ArtifactSet) {
  const target = resolveTarget({ surface: 'web' })
  return set.manifest.packages.filter(p => isTargetCompatible(p, target))
}
export function artifactPrerequisites(context: WebHarness, set: ArtifactSet): string {
  assertArtifactsUnchanged(set); ensurePnpmShim(context)
  for (const item of set.manifest.packages) checkPackageImports(set.packages.get(item.name)!, join(context.runDir, 'contracts', item.name.slice(7)))
  return `package contracts/imports passed; manifest SHA-256 ${set.hash}`
}
export async function installArtifacts(context: WebHarness, set: ArtifactSet): Promise<string> {
  const evidence = []
  for (const item of webArtifacts(set)) {
    const archive = copyArtifact(set, item, join(context.runDir, 'inputs', item.path))
    await runDsh(context, `install-${item.name.slice(7)}`, ['plugin', '--profile', 'web', 'add', archive], context.home)
    assertConsumed(set, item, archive)
    const actual = checkInstalledPackage(set.packages.get(item.name)!, join(context.home, 'profiles/web'), set.root)
    evidence.push({ name: item.name, sha256: item.sha256, actual })
  }
  return JSON.stringify(evidence)
}
export function checkArtifactInstallations(context: WebHarness, set: ArtifactSet): void {
  assertArtifactsUnchanged(set)
  for (const item of webArtifacts(set)) {
    assertConsumed(set, item, join(context.runDir, 'inputs', item.path))
    checkInstalledPackage(set.packages.get(item.name)!, join(context.home, 'profiles/web'), set.root)
  }
}
