import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { commandEnv, configuredDsh, configuredPnpm, checkTestBrowser, loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import { childEnv } from '../../../scripts/.build/core/web-harness.js'
import { profileDir } from '../../../scripts/.build/core/dsh.js'
import { configFixture } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

it('L1 command context: flags override env/file without modifying either, including test settings', () => {
  const f = configFixture()
  try {
    initializeConfig({ ...f.options, testTimeoutMs: 4321 }, f.root, f.env)
    const saved = readFileSync(f.paths.local, 'utf8')
    const env = { ...f.env, Path: 'extra', DSH_CLI: 'missing', DSH_PNPM: 'missing', CHROME_PATH: 'missing', DSH_E2E_BROWSER: 'chrome' }
    const before = { ...env }
    const settings = loadCommandContext({ ...f.options, testBrowser: 'chromium', testTimeoutMs: 1234 }, f.root, env, 'test')
    assert.equal(settings.config.test.timeoutMs, 1234)
    assert.equal(loadCommandContext({}, f.root, f.env).config.test.timeoutMs, 4321)
    assert.equal(configuredPnpm(settings), f.options.pnpmScript)
    assert.equal(configuredDsh(settings, true).source, f.entry)
    assert.doesNotThrow(() => checkTestBrowser(settings))
    const child = commandEnv(settings)
    assert.equal(child.DSH_CLI, undefined)
    assert.equal(child.DSH_PNPM, f.options.pnpmScript)
    assert.equal(child.DSH_E2E_BROWSER, 'chromium')
    assert.deepEqual(Object.keys(child).filter(k => k.toUpperCase() === 'PATH'), ['PATH'])
    assert.deepEqual(env, before)
    assert.equal(readFileSync(f.paths.local, 'utf8'), saved)
    assert.throws(() => configuredPnpm(loadCommandContext({ pnpmScript: 'missing' }, f.root, f.env)), /tools.pnpmScript/)
  } finally { removeDir(f.root) }
})

it('L1 command context: absent tools never trigger discovery; unrelated browsers are checked only when used', () => {
  const f = configFixture()
  try {
    const config = JSON.parse(readFileSync(f.paths.example, 'utf8'))
    config.web.browserPath = 'missing-edge'
    config.test.browserPath = 'missing-chrome'
    writeFileSync(f.paths.local, JSON.stringify(config))
    const settings = loadCommandContext({}, f.root, f.env)
    assert.equal(configuredDsh(settings, true).source, f.entry)
    assert.throws(() => configuredPnpm(settings), /required for this command/)
    assert.throws(() => checkTestBrowser(settings), /test.browserPath/)
    assert.equal(commandEnv(settings).DSH_CLI, undefined)
    assert.equal(commandEnv(settings).DSH_PNPM, undefined)
  } finally { removeDir(f.root) }
})

it('L1 harness configuration: disposable homes override session settings and do not read the personal patch', () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    writeFileSync(f.paths.patch, 'invalid personal YAML: [')
    const settings = loadCommandContext({}, f.root, {
      ...f.env, dsh_home: 'personal', dsh_profile: 'personal', dsh_profile_dir: 'personal', dsh_web_url: 'private',
      PNPM_CONFIG_STORE_DIR: 'personal-store',
    })
    const home = join(f.root, 'disposable')
    assert.equal(profileDir('web', { dsh_home: home, dsh_profile: 'personal', dsh_profile_dir: 'personal' }), join(home, 'profiles/web'))
    const env = childEnv({ settings, runner: configuredDsh(settings, true), home, runDir: f.root, logDir: f.root, options: { timeoutMs: 10 } }, home)
    assert.equal(env.DSH_HOME, home)
    assert.equal(env.DSH_PROFILE, 'web')
    assert.equal(env.DSH_PROFILE_DIR, join(home, 'profiles/web'))
    assert.equal(Object.keys(env).some(k => k.toUpperCase() === 'DSH_WEB_URL'), false)
    assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === 'DSH_HOME'), ['DSH_HOME'])
    assert.equal(env.pnpm_config_store_dir, join(f.root, 'pnpm-store'))
  } finally { removeDir(f.root) }
})
