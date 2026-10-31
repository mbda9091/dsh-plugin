import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostCapabilityCheck } from '../../../scripts/.build/core/host-capability.js'
import { webArtifacts } from '../../../scripts/.build/core/artifact-harness.js'
import { checkInstalledPackage } from '../../../scripts/.build/core/artifact-package.js'

/** Real delivery tests use synthetic bundles. Their test-only adapter verifies
 * registration and response; production has no adapter for these package names. */
export const checkFixtureCapabilities: HostCapabilityCheck = async (context, set) => {
  const evidence = []
  for (const item of webArtifacts(set).filter(p => !p.client)) {
    const pkg = set.packages.get(item.name)!
    const actual = checkInstalledPackage(pkg, join(context.home, 'profiles/web'), set.root)
    const module = await import(pathToFileURL(join(actual, pkg.entry)).href)
    let handler: (() => string) | undefined
    module.apply({ on: (event: string, callback: () => string) => { assert.equal(event, 'fixture/check'); handler = callback } })
    assert.ok(handler); assert.equal(handler(), item.name.slice(7))
    evidence.push({ name: item.name, sha256: item.sha256, adapter: 'fixture-v1', checks: ['registration', 'response'], status: 'passed' })
  }
  return JSON.stringify(evidence)
}
