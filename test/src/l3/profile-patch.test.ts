import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeDefaults, planProfilePatch, commitProfilePatch } from '../../../scripts/.build/core/profile-patch.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'
const defaults = [{ name: '@mbda9091/notify-web', rows: [{ id: 'notify-web', name: '@mbda9091/notify-web', config: { notifyOnApproval: true } }] }]
it('L3 namespace patch preserves !!js, comments and disabled rows byte-for-byte on append and repeat', () => {
  const before = `# header\r\n- id: approval-allowlist # identity\r\n  name: '@mbda9091/approval-allowlist'\r\n  disabled: !!js 'process.env.TEST === "yes"' # preserve\r\n  config:\r\n    mode: observe # user's choice\r\n# end comment\r\n`
  const next = mergeDefaults(before, defaults)
  assert.ok(next.text.startsWith(before))
  assert.deepEqual(next.added, ['@mbda9091/notify-web'])
  assert.equal(mergeDefaults(next.text, defaults).text, next.text)
  assert.equal(mergeDefaults('# empty\n[] # retained\n', []).text, '# empty\n[] # retained\n')
  assert.match(mergeDefaults('# empty\n[] # retained\n', defaults).text, /# retained/)
  assert.throws(() => mergeDefaults('- id: notify-web\n  name: bad\n', defaults), /conflicting/)
  assert.throws(() => mergeDefaults('{}', defaults), /array/)
  const byId = '- id: notify-web\n  disabled: true # keep my preference\n'
  assert.equal(mergeDefaults(byId, defaults).text, byId)
})
it('L3 namespace patch keeps root untouched, backs up only changed namespace file, rejects concurrent edits', () => {
  const root = makeTempDir('namespace-patch')
  try {
    const original = '# personal\n- id: model\n  config: !!js "secret()"\n'
    writeFileSync(join(root, 'cordis.patch.yml'), original)
    const first = planProfilePatch(root, defaults)
    assert.equal(commitProfilePatch(first), null)
    assert.equal(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), original)
    const unchanged = planProfilePatch(root, defaults)
    assert.equal(commitProfilePatch(unchanged), null)
    assert.equal(existsSync(first.path + '.bak'), false)
    const extra = [{ name: '@mbda9091/alpha', rows: [{ id: 'alpha', name: '@mbda9091/alpha', config: {} }] }]
    const second = planProfilePatch(root, extra)
    assert.equal(commitProfilePatch(second), first.path + '.bak')
    assert.equal(readFileSync(first.path + '.bak', 'utf8'), first.text)
    const pending = planProfilePatch(root, [])
    writeFileSync(first.path, '# concurrent\n[]\n')
    assert.throws(() => commitProfilePatch(pending), /changed/)
  } finally { removeDir(root) }
})

it('L3 shipped notify defaults match runtime defaults and approval starts observe-only', async () => {
  const { repoRoot } = await import('../harness/tmp.js')
  const { parse } = await import('yaml')
  const { DEFAULTS } = await import('../../../notify-web/lib/index.js')
  const rows = parse(readFileSync(join(repoRoot, 'notify-web/profile.defaults.patch.yml'), 'utf8'))
  assert.deepEqual(rows[0].config, DEFAULTS)
  const approval = parse(readFileSync(join(repoRoot, 'approval-allowlist/profile.defaults.patch.yml'), 'utf8'))
  assert.equal(approval[0].config.mode, 'observe')
  assert.deepEqual(approval[0].config.rules, [])
  assert.equal(approval[0].config.logArguments, false)
})
