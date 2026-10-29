import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateTarget as evaluateAppRestart } from '@local/app-restart'
import { evaluateTarget as evaluateAllowlist } from '@local/approval-allowlist'
import { evaluateTarget as evaluateNotify } from '@local/desktop-notify'
import { evaluateTarget as evaluateWebNotify } from '@local/notify-web'

const DESKTOP_WINDOWS = { surfaces: ['desktop'], platforms: ['windows'] }
const WEB_UNIVERSAL = { surfaces: ['web'], platforms: ['mac', 'windows'] }
const UNIVERSAL = { surfaces: ['desktop', 'web'], platforms: ['mac', 'windows'] }

describe('L1 plugin target guards', () => {
  it('accepts a desktop plugin on desktop/windows', () => {
    assert.equal(evaluateAppRestart(DESKTOP_WINDOWS, { surface: 'desktop', platform: 'windows' }), undefined)
    assert.equal(evaluateNotify(DESKTOP_WINDOWS, { surface: 'desktop', platform: 'windows' }), undefined)
  })

  it('rejects a desktop plugin in the web surface', () => {
    const problem = evaluateAppRestart(DESKTOP_WINDOWS, { surface: 'web', platform: 'windows' })
    assert.ok(problem !== undefined)
    assert.match(problem, /^target mismatch: declared surfaces=desktop platforms=windows; current surface=web platform=windows$/)
  })

  it('rejects a desktop plugin on another platform', () => {
    const problem = evaluateNotify(DESKTOP_WINDOWS, { surface: 'desktop', platform: 'mac' })
    assert.ok(problem !== undefined)
    assert.match(problem, /current surface=desktop platform=mac$/)
  })

  it('rejects the headless surface for every packaged plugin', () => {
    for (const evaluate of [evaluateAppRestart, evaluateNotify, evaluateAllowlist, evaluateWebNotify]) {
      const problem = evaluate(
        { surfaces: ['desktop', 'web'], platforms: ['windows', 'mac'] },
        { surface: 'headless', platform: 'windows' },
      )
      assert.ok(problem !== undefined)
      assert.match(problem, /target mismatch/)
    }
  })

  it('accepts the web plugin on both web platforms and rejects desktop', () => {
    assert.equal(evaluateWebNotify(WEB_UNIVERSAL, { surface: 'web', platform: 'windows' }), undefined)
    assert.equal(evaluateWebNotify(WEB_UNIVERSAL, { surface: 'web', platform: 'mac' }), undefined)
    const problem = evaluateWebNotify(WEB_UNIVERSAL, { surface: 'desktop', platform: 'windows' })
    assert.ok(problem !== undefined)
    assert.match(problem, /declared surfaces=web/)
  })

  it('accepts the dual-target plugin on both surfaces and platforms', () => {
    for (const environment of [
      { surface: 'desktop', platform: 'windows' },
      { surface: 'desktop', platform: 'mac' },
      { surface: 'web', platform: 'windows' },
      { surface: 'web', platform: 'mac' },
    ]) {
      assert.equal(evaluateAllowlist(UNIVERSAL, environment), undefined)
    }
  })

  it('rejects an unsupported platform for the dual-target plugin', () => {
    const problem = evaluateAllowlist(UNIVERSAL, { surface: 'web', platform: 'linux' })
    assert.ok(problem !== undefined)
    assert.match(problem, /platforms=mac\+windows; current surface=web platform=linux$/)
  })
})
