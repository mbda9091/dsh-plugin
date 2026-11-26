import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateTarget as evaluateRoleAgent } from '@mbda9091/role-agent'
import { evaluateTarget as evaluateWebNotify } from '@mbda9091/notify-web'

const DESKTOP_WINDOWS = { surfaces: ['desktop'], platforms: ['windows'] }
const WEB_UNIVERSAL = { surfaces: ['web'], platforms: ['linux', 'mac', 'windows'] }

describe('L1 plugin target guards', () => {
  it('accepts a desktop envelope on desktop/windows', () => {
    assert.equal(evaluateRoleAgent(DESKTOP_WINDOWS, { surface: 'desktop', platform: 'windows' }), undefined)
  })

  it('rejects a desktop-only envelope in the web surface', () => {
    const problem = evaluateRoleAgent(DESKTOP_WINDOWS, { surface: 'web', platform: 'windows' })
    assert.ok(problem !== undefined)
    assert.match(problem, /^target mismatch: declared surfaces=desktop platforms=windows; current surface=web platform=windows$/)
  })

  it('rejects a Windows-only envelope on another platform', () => {
    const problem = evaluateRoleAgent(DESKTOP_WINDOWS, { surface: 'desktop', platform: 'mac' })
    assert.ok(problem !== undefined)
    assert.match(problem, /current surface=desktop platform=mac$/)
  })

  it('rejects the headless surface for every packaged plugin', () => {
    for (const evaluate of [evaluateRoleAgent, evaluateWebNotify]) {
      const problem = evaluate(
        { surfaces: ['desktop', 'web'], platforms: ['windows', 'mac', 'linux'] },
        { surface: 'headless', platform: 'windows' },
      )
      assert.ok(problem !== undefined)
      assert.match(problem, /target mismatch/)
    }
  })

  it('accepts Linux Web and rejects a Windows-only envelope there', () => {
    const environment = { surface: 'web', platform: 'linux' }
    assert.equal(evaluateWebNotify(WEB_UNIVERSAL, environment), undefined)
    assert.match(evaluateRoleAgent(DESKTOP_WINDOWS, environment)!, /target mismatch/)
  })

  it('accepts the web plugin on both web platforms and rejects desktop', () => {
    assert.equal(evaluateWebNotify(WEB_UNIVERSAL, { surface: 'web', platform: 'windows' }), undefined)
    assert.equal(evaluateWebNotify(WEB_UNIVERSAL, { surface: 'web', platform: 'mac' }), undefined)
    const problem = evaluateWebNotify(WEB_UNIVERSAL, { surface: 'desktop', platform: 'windows' })
    assert.ok(problem !== undefined)
    assert.match(problem, /declared surfaces=web/)
  })

})
