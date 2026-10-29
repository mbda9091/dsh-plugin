import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { detectEnvironment as detectAppRestart } from '@local/app-restart'
import { detectEnvironment as detectAllowlist } from '@local/approval-allowlist'
import { detectEnvironment as detectNotify } from '@local/desktop-notify'
import { withElectron } from '../harness/env.js'
import { createFakeContext } from '../harness/fake-context.js'

const detectors = [
  { name: 'app-restart', detect: detectAppRestart },
  { name: 'desktop-notify', detect: detectNotify },
  { name: 'approval-allowlist', detect: detectAllowlist },
]

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const expectedPlatform = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin'
    ? 'mac'
    : 'linux'

function detect(detector: (typeof detectors)[number], services: Record<string, unknown>): { surface: string; platform: string } {
  return detector.detect(createFakeContext(services) as unknown as Context)
}

describe('L3 target environment detection', () => {
  it('reports desktop when the Electron engine is present, even with web bundles', () => {
    withElectron(() => {
      for (const detector of detectors) {
        const environment = detect(detector, { profileContext: { startedBundles: WEB_BUNDLES } })
        assert.equal(environment.surface, 'desktop', `${detector.name} must prefer the Electron signal`)
        assert.equal(environment.platform, expectedPlatform)
      }
    })
  })

  it('reports web when the profile composed the web-app bundle', () => {
    for (const detector of detectors) {
      const environment = detect(detector, { profileContext: { startedBundles: WEB_BUNDLES } })
      assert.equal(environment.surface, 'web', `${detector.name} must see the web bundle`)
      assert.equal(environment.platform, expectedPlatform)
    }
  })

  it('accepts an aliased web-app bundle name', () => {
    for (const detector of detectors) {
      const environment = detect(detector, {
        profileContext: { startedBundles: ['@deepseek-ai/dsh-base', 'my-org/dsh-web-app'] },
      })
      assert.equal(environment.surface, 'web')
    }
  })

  it('reports headless for a plain Node CLI run', () => {
    for (const detector of detectors) {
      const environment = detect(detector, { profileContext: { startedBundles: ['@deepseek-ai/dsh-base'] } })
      assert.equal(environment.surface, 'headless')
    }
  })

  it('does not depend on the webServer service, which is not up during apply', () => {
    for (const detector of detectors) {
      const environment = detect(detector, { webServer: {} })
      assert.equal(environment.surface, 'headless', `${detector.name} must not treat webServer as the surface signal`)
    }
  })

  it('ignores malformed profile data instead of throwing', () => {
    for (const detector of detectors) {
      assert.equal(detector.detect(createFakeContext() as unknown as Context).surface, 'headless')
      assert.equal(
        detect(detector, { profileContext: { startedBundles: 'dsh-web-app' } }).surface,
        'headless',
      )
      assert.equal(
        detect(detector, { profileContext: { startedBundles: [42, null, '@deepseek-ai/dsh-base'] } }).surface,
        'headless',
      )
    }
  })
})
