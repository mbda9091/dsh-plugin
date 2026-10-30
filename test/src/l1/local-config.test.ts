import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadRepoConfig, resolveConfig } from '../../../scripts/.build/core/config.js'
import { discoverDsh, webDsh } from '../../../scripts/.build/core/config-tools.js'
import { initializeConfig, checkConfig } from '../../../scripts/.build/commands/config.js'
import { inspectWebPatch, renderWebPatch } from '../../../scripts/.build/core/web-patch.js'
import { webArguments } from '../../../scripts/.build/commands/web.js'
import { configFixture } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

interface InvalidatableConfig {
  version: unknown
  web: Record<string, unknown>
  tools: Record<string, unknown>
}

describe('L1 local configuration lifecycle', () => {
  it('previews without writes, initializes quoted paths, then preserves edits and ignores template changes', () => {
    const f = configFixture()
    try {
      const before = readdirSync(f.root, { recursive: true })
      assert.equal(initializeConfig({ ...f.options, dryRun: true }, f.root, f.env).state, 'preview')
      assert.deepEqual(readdirSync(f.root, { recursive: true }), before)
      assert.equal(initializeConfig(f.options, f.root, f.env).state, 'created')
      const local = JSON.parse(readFileSync(f.paths.local, 'utf8'))
      local.web.openBrowser = false
      writeFileSync(f.paths.local, JSON.stringify(local))
      const saved = readFileSync(f.paths.local, 'utf8')
      const patch = readFileSync(f.paths.patch, 'utf8')
      const parsed = parse(patch) as Array<{ id: string; config: { root?: string[] } }>
      assert.equal(parsed[0]?.config.root?.[0], join(f.root, 'app-restart/lib'))
      writeFileSync(f.paths.example, 'broken template')
      writeFileSync(f.paths.patchExample, 'broken template')
      assert.equal(initializeConfig(f.options, f.root, f.env).state, 'existing')
      assert.equal(loadRepoConfig(f.root, f.env).config.web.openBrowser, false)
      assert.equal(readFileSync(f.paths.local, 'utf8'), saved)
      assert.equal(readFileSync(f.paths.patch, 'utf8'), patch)
      assert.equal(existsSync(f.env.DSH_HOME!), false)
    } finally { removeDir(f.root) }
  })

  it('rejects a partial pair and never fills in the missing file', () => {
    const f = configFixture()
    try {
      writeFileSync(f.paths.local, 'keep exactly')
      assert.throws(() => initializeConfig(f.options, f.root, f.env), /incomplete local configuration/)
      assert.equal(readFileSync(f.paths.local, 'utf8'), 'keep exactly')
      assert.equal(existsSync(f.paths.patch), false)
    } finally { removeDir(f.root) }
  })

  it('requires local config and reports malformed JSON without exposing its content', () => {
    const f = configFixture()
    try {
      assert.throws(() => loadRepoConfig(f.root, f.env), /run node scripts\/bootstrap\.mjs config init/)
      writeFileSync(f.paths.local, '{"password":"do-not-echo-this"')
      assert.throws(() => loadRepoConfig(f.root, f.env), error => error instanceof Error
        && error.message.includes('valid JSON') && !error.message.includes('do-not-echo-this'))
    } finally { removeDir(f.root) }
  })

  for (const [name, change] of [
    ['version', (c: InvalidatableConfig) => { c.version = 2 }],
    ['unknown field', (c: InvalidatableConfig) => { c.web.openBrowsre = false }],
    ['missing field', (c: InvalidatableConfig) => { delete c.web.openBrowser }],
    ['string boolean', (c: InvalidatableConfig) => { c.web.openBrowser = 'false' }],
    ['timeout', (c: InvalidatableConfig) => { c.web.startupTimeoutMs = 0 }],
    ['browser', (c: InvalidatableConfig) => { c.web.browser = 'typo' }],
    ['blank path', (c: InvalidatableConfig) => { c.tools.dshCli = ' ' }],
  ] as const) {
    it(`rejects invalid ${name} even when an override could mask it`, () => {
      const f = configFixture()
      try {
        const config = JSON.parse(readFileSync(f.paths.example, 'utf8'))
        change(config)
        writeFileSync(f.paths.local, JSON.stringify(config))
        assert.throws(() => loadRepoConfig(f.root, f.env, { openBrowser: true, browser: 'default', dshCli: f.cli }))
      } finally { removeDir(f.root) }
    })
  }

  it('uses flags over environment over file, with repo-relative paths and no writes', () => {
    const f = configFixture()
    try {
      initializeConfig(f.options, f.root, f.env)
      const before = readFileSync(f.paths.local, 'utf8')
      const loaded = loadRepoConfig(f.root, { DSH_CLI: 'env-cli', CHROME_PATH: 'env-chrome', DSH_E2E_BROWSER: 'chromium' }, {
        dshCli: 'flag-cli', openBrowser: false, startupTimeoutMs: 777,
      })
      assert.equal(loaded.config.tools.dshCli, resolve(f.root, 'flag-cli'))
      assert.equal(loaded.config.test.browserPath, resolve(f.root, 'env-chrome'))
      assert.equal(loaded.config.test.browser, 'chromium')
      assert.equal(loaded.config.web.openBrowser, false)
      assert.equal(loaded.config.web.startupTimeoutMs, 777)
      assert.equal(loaded.sources['tools.dshCli'], 'command line')
      assert.equal(loaded.sources['test.browserPath'], 'CHROME_PATH')
      assert.equal(readFileSync(f.paths.local, 'utf8'), before)
      assert.throws(() => resolveConfig(loaded.config, f.root, f.paths.schema, {}, { startupTimeoutMs: NaN }))
    } finally { removeDir(f.root) }
  })

  it('does not fall back from an invalid explicit tool path', () => {
    const f = configFixture()
    try {
      assert.throws(() => initializeConfig({ ...f.options, dshCli: join(f.root, 'missing') }, f.root, f.env), /tools.dshCli/)
      assert.throws(() => initializeConfig({ ...f.options, pnpmScript: f.cli }, f.root, f.env), /pnpm.cjs/)
      assert.equal(existsSync(f.paths.local), false)
    } finally { removeDir(f.root) }
  })

  it('checks moved-repository metadata even if the old directories still exist', () => {
    const f = configFixture()
    try {
      initializeConfig(f.options, f.root, f.env)
      const moved = join(f.root, 'other-checkout')
      assert.match(inspectWebPatch(f.paths.patch, moved).warnings.join('\n'), /location changed/)
      for (const root of inspectWebPatch(f.paths.patch, f.root).roots) mkdirSync(root, { recursive: true })
      assert.deepEqual(checkConfig(f.root, f.env).warnings, [])
    } finally { removeDir(f.root) }
  })

  it('expands only supported YAML fields, preserves Windows globs and never evaluates !!js', () => {
    const f = configFixture()
    try {
      const template = readFileSync(f.paths.patchExample, 'utf8')
      assert.throws(() => renderWebPatch(template + '\n- id: x\n  config: {url: "${secret}"}\n', f.root), /placeholder outside/)
      assert.throws(() => renderWebPatch(template.replace('app-restart/lib', '../escape'), f.root), /invalid HMR/)
      const patch = renderWebPatch(template, f.root)
      assert.deepEqual(parse(patch)[0].config.ignored, parse(template)[0].config.ignored)
      writeFileSync(f.paths.patch, patch + '\n- id: x\n  disabled: !!js "throw new Error(\'must not execute\')"\n')
      assert.equal(inspectWebPatch(f.paths.patch, f.root).roots.length, 4)
      writeFileSync(f.paths.patch, '- id: x\n  config: [\n')
      assert.throws(() => inspectWebPatch(f.paths.patch, f.root), /invalid YAML/)
      writeFileSync(f.paths.patch, '- id: hmr\n  config: {root: [relative]}\n')
      assert.throws(() => inspectWebPatch(f.paths.patch, f.root), /absolute paths/)
    } finally { removeDir(f.root) }
  })

  it('selects a recognized Node shim and rejects opaque and Electron launchers', { skip: process.platform !== 'win32' }, () => {
    const f = configFixture()
    try {
      assert.equal(discoverDsh(null, { Path: f.root }).path, f.cli)
      const opaque = join(f.root, 'unknown.cmd')
      writeFileSync(opaque, '@echo off\r\necho unknown\r\n')
      assert.throws(() => webDsh(opaque, f.env), /unrecognized CLI engine/)
      const electron = join(f.root, 'electron.cmd')
      writeFileSync(electron, `"${process.execPath}" --expose-internals "${f.entry}"`)
      assert.throws(() => webDsh(electron, f.env), /Electron CLI/)
    } finally { removeDir(f.root) }
  })

  it('separates launcher overrides from DSH arguments', () => {
    assert.deepEqual(webArguments(['--no-open', '--startup-timeout=750', '--port', '0', '--browser', 'default']), {
      overrides: { openBrowser: false, startupTimeoutMs: 750, browser: 'default' }, forward: ['--port', '0'], help: false,
    })
    assert.throws(() => webArguments(['--dsh-cli']), /requires a value/)
  })
})
