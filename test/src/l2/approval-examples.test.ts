import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { readGrantsFile } from '@local/approval-allowlist'
import { fileURLToPath } from 'node:url'

it('M4 shipped grant examples are valid but do not grant permission by default', () => {
  const base = new URL('../../../approval-allowlist/', import.meta.url)
  const empty = readGrantsFile(fileURLToPath(new URL('examples/grants.empty.json', base)))
  assert.deepEqual(empty, { version: 1, rules: [] })
  const examples = readGrantsFile(fileURLToPath(new URL('examples/grants.example.json', base)))
  assert.equal(examples.rules.length, 2)
  for (const rule of examples.rules) {
    assert.ok(Date.parse(rule.expiresAt!) < Date.now(), 'examples must remain inert even if copied')
    assert.match(JSON.stringify(rule.arguments), /REPLACE_ME/)
  }
  const rows = parse(readFileSync(new URL('examples/profile.patch.example.yml', base), 'utf8'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'approval-allowlist')
  assert.equal(rows[0].config.mode, 'observe')
  assert.equal(rows[0].config.rootOnly, true)
  assert.equal(rows[0].config.logArguments, false)
  const manifest = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'))
  assert.ok(manifest.files.includes('examples/*.json'))
  assert.ok(manifest.files.includes('examples/*.yml'))
  assert.deepEqual(manifest.dsh.targets, { surfaces: ['web'], platforms: ['mac'] })
})
