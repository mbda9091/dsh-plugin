import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { profileDir, profileName, readProfileManifest, resolveInstallMode } from '../../../scripts/.build/core/dsh.js'
import { resolveDsh } from '../../../scripts/.build/core/dsh-cli.js'
import { errorMessage, isRecord, readJson, readText, stringArray, writeText } from '../../../scripts/.build/core/json.js'
import { compare, discoverPlugins } from '../../../scripts/.build/core/plugins.js'
import {
  formatPluginTarget,
  isTargetCompatible,
  platformLabel,
  resolveTarget,
  surfaceLabel,
} from '../../../scripts/.build/core/targets.js'
import { withEnv } from '../harness/env.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

describe('L1 scripts/core: Windows DSH CLI shims', () => {
  for (const launcher of ['"%_prog%"', '"%~dp0\\node.exe"']) {
    it(`runs the ${launcher} shim entry directly under Node`, () => {
      const directory = makeTempDir('dsh-shim')
      try {
        const script = join(directory, 'lib', 'bin.js')
        mkdirSync(join(directory, 'lib'), { recursive: true })
        writeFileSync(script, '', 'utf8')
        const shim = join(directory, 'dsh.cmd')
        writeFileSync(shim, `@echo off\r\n${launcher} "%~dp0\\lib\\bin.js" %*\r\n`, 'utf8')
        const runner = resolveDsh({ env: { DSH_CLI: shim }, platform: 'win32' })
        assert.equal(runner.command, process.execPath)
        assert.equal(runner.verbatim, false)
        assert.deepEqual(runner.env, {})
        assert.deepEqual(runner.build(['web', '--no-open']), [script, 'web', '--no-open'])
      } finally {
        removeDir(directory)
      }
    })
  }
})

describe('L1 scripts/core: target resolution', () => {
  it('keeps explicit surface and platform', () => {
    assert.deepEqual(resolveTarget({ surface: 'web', platform: 'mac', profile: 'desktop' }), {
      surface: 'web',
      platform: 'mac',
    })
  })

  it('infers the surface from the profile name', () => {
    assert.equal(resolveTarget({ profile: 'web', platform: 'windows' }).surface, 'web')
    assert.equal(resolveTarget({ profile: 'desktop', platform: 'windows' }).surface, 'desktop')
  })

  it('infers the surface from DSH_PROFILE when no profile is passed', async () => {
    await withEnv('DSH_PROFILE', 'web', () => {
      assert.equal(resolveTarget({ platform: 'windows' }).surface, 'web')
    })
  })

  it('rejects an unknown profile instead of guessing', () => {
    assert.throws(() => resolveTarget({ profile: 'headless', platform: 'windows' }), /Cannot infer surface from profile 'headless'/)
  })

  it('rejects malformed explicit values', () => {
    assert.throws(() => resolveTarget({ surface: 'terminal', platform: 'windows' }), /Unsupported surface 'terminal'/)
    assert.throws(() => resolveTarget({ surface: 'web', platform: 'linux' }), /Unsupported platform 'linux'/)
  })

  it('maps the current OS when the platform is omitted', () => {
    if (process.platform === 'linux') {
      assert.throws(() => resolveTarget({ surface: 'web' }), /Linux is reserved/)
      return
    }
    const expected = process.platform === 'win32' ? 'windows' : 'mac'
    assert.equal(resolveTarget({ surface: 'web' }).platform, expected)
  })
})

describe('L1 scripts/core: target predicates and labels', () => {
  it('checks both surface and platform', () => {
    const plugin = { surfaces: ['web'], platforms: ['mac', 'windows'] }
    assert.equal(isTargetCompatible(plugin, { surface: 'web', platform: 'windows' }), true)
    assert.equal(isTargetCompatible(plugin, { surface: 'desktop', platform: 'windows' }), false)
    assert.equal(isTargetCompatible(plugin, { surface: 'web', platform: 'mac' }), true)
    assert.equal(isTargetCompatible({ surfaces: [], platforms: [] }, { surface: 'web', platform: 'mac' }), false)
  })

  it('formats the declared targets', () => {
    assert.equal(formatPluginTarget({ surfaces: ['desktop', 'web'], platforms: ['mac'] }), 'desktop+web/mac')
  })

  it('labels surfaces in both languages', () => {
    assert.equal(surfaceLabel(['desktop', 'web'], 'zh'), '通用')
    assert.equal(surfaceLabel(['desktop'], 'zh'), '桌面')
    assert.equal(surfaceLabel(['web'], 'zh'), 'Web')
    assert.equal(surfaceLabel([], 'zh'), '未声明')
    assert.equal(surfaceLabel(['desktop', 'web'], 'en'), 'Universal')
    assert.equal(surfaceLabel(['desktop'], 'en'), 'Desktop')
    assert.equal(surfaceLabel(['web'], 'en'), 'Web')
    assert.equal(surfaceLabel([], 'en'), 'Undeclared')
  })

  it('labels platforms in both languages', () => {
    assert.equal(platformLabel(['mac', 'windows'], 'zh'), '通用平台')
    assert.equal(platformLabel(['windows'], 'zh'), 'Windows')
    assert.equal(platformLabel(['mac'], 'zh'), 'macOS')
    assert.equal(platformLabel([], 'zh'), '未声明')
    assert.equal(platformLabel(['mac', 'windows'], 'en'), 'All platforms')
    assert.equal(platformLabel([], 'en'), 'Undeclared')
  })

  it('compares by code unit, not host locale', () => {
    assert.equal(compare('a', 'b'), -1)
    assert.equal(compare('b', 'a'), 1)
    assert.equal(compare('a', 'a'), 0)
    assert.equal(compare('Z', 'a'), -1)
  })
})

describe('L1 scripts/core: JSON helpers', () => {
  it('recognizes plain objects only', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord([]), false)
    assert.equal(isRecord(null), false)
    assert.equal(isRecord('x'), false)
  })

  it('keeps only string array items', () => {
    assert.deepEqual(stringArray(['a', 1, null, 'b']), ['a', 'b'])
    assert.deepEqual(stringArray('a'), [])
  })

  it('writes UTF-8 without a BOM and reads it back', () => {
    const dir = makeTempDir('json')
    try {
      const path = join(dir, 'nested', 'value.json')
      writeText(path, '{"text":"你好"}')
      const buffer = readText(path)
      assert.equal(buffer, '{"text":"你好"}')
      assert.equal((readJson(path) as { text: string }).text, '你好')
    } finally {
      removeDir(dir)
    }
  })

  it('reports malformed JSON and unknown errors', () => {
    const dir = makeTempDir('json-bad')
    try {
      const path = join(dir, 'bad.json')
      writeFileSync(path, '{nope', 'utf8')
      assert.throws(() => readJson(path), SyntaxError)
    } finally {
      removeDir(dir)
    }
    assert.equal(errorMessage(new Error('boom')), 'boom')
    assert.equal(errorMessage('plain'), 'plain')
  })
})

describe('L1 scripts/core: profile paths and install modes', () => {
  it('defaults the profile name to desktop', async () => {
    await withEnv('DSH_PROFILE', undefined, () => {
      assert.equal(profileName(), 'desktop')
    })
    await withEnv('DSH_PROFILE', '', () => {
      assert.equal(profileName(), 'desktop')
    })
    await withEnv('DSH_PROFILE', 'web', () => {
      assert.equal(profileName(), 'web')
    })
  })

  it('resolves the profile directory from DSH_HOME', async () => {
    const home = join('D:', 'dsh-home')
    await withEnv('DSH_HOME', home, () =>
      withEnv('DSH_PROFILE_DIR', undefined, () => {
        assert.equal(profileDir('web'), join(home, 'profiles', 'web'))
      }),
    )
  })

  it('only reuses DSH_PROFILE_DIR for the current profile', async () => {
    const explicit = join('D:', 'explicit-profile')
    await withEnv('DSH_PROFILE', 'web', () =>
      withEnv('DSH_PROFILE_DIR', explicit, () => {
        assert.equal(profileDir('web'), explicit)
        assert.notEqual(profileDir('desktop'), explicit)
      }),
    )
  })

  it('reads a profile manifest and rejects a missing one', async () => {
    const home = makeTempDir('profile')
    try {
      await withEnv('DSH_HOME', home, () =>
        withEnv('DSH_PROFILE_DIR', undefined, () => {
          assert.throws(() => readProfileManifest('web'), /profile manifest not found/)
          const manifestDir = join(home, 'profiles', 'web')
          mkdirSync(manifestDir, { recursive: true })
          writeFileSync(join(manifestDir, 'package.json'), '{"name":"dsh-profile-web"}', 'utf8')
          assert.equal(readProfileManifest('web')['name'], 'dsh-profile-web')
        }),
      )
    } finally {
      removeDir(home)
    }
  })

  it('describes link/tarball installs and detects inconsistent ones', () => {
    assert.equal(resolveInstallMode(null, false), 'not installed')
    assert.equal(resolveInstallMode('link:D:/repo/plugin', true), 'link (dev)')
    assert.equal(resolveInstallMode('file:../dist/plugin.tgz', false), 'tarball (stable)')
    assert.equal(resolveInstallMode('https://example.test/plugin.tgz', false), 'tarball (stable)')
    assert.equal(resolveInstallMode('file:../dist/plugin.tgz', true), 'tarball spec, but LINKED')
    assert.equal(resolveInstallMode('https://example.test/plugin.tgz', true), 'tarball spec, but LINKED')
    assert.equal(resolveInstallMode('link:D:/repo/plugin', false), 'link spec, but COPY')
    assert.equal(resolveInstallMode('1.2.3', false), 'package (1.2.3)')
  })
})

describe('L1 scripts/core: plugin discovery basics', () => {
  it('only treats dsh.bundle packages as plugins', () => {
    const repo = makeTempDir('discovery')
    try {
      const withBundle = join(repo, 'b-plugin')
      mkdirSync(withBundle, { recursive: true })
      writeFileSync(
        join(withBundle, 'package.json'),
        JSON.stringify({ name: '@local/b-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' }, targets: { surfaces: ['web'], platforms: ['windows'] } } }),
        'utf8',
      )

      const withoutBundle = join(repo, 'a-tool')
      mkdirSync(withoutBundle, { recursive: true })
      writeFileSync(join(withoutBundle, 'package.json'), JSON.stringify({ name: '@local/a-tool' }), 'utf8')

      const skipped = ['node_modules', 'dist', '.hidden']
      for (const name of skipped) {
        const dir = join(repo, name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
          'utf8',
        )
      }

      // The function takes the repository path explicitly, so this temporary
      // tree exercises filtering without touching the real repository.
      const plugins = discoverPlugins(repo)
      assert.deepEqual(plugins.map((plugin) => plugin.dirName), ['b-plugin'])
      assert.deepEqual(plugins[0]?.surfaces, ['web'])
      assert.deepEqual(plugins[0]?.platforms, ['windows'])
    } finally {
      removeDir(repo)
    }
  })

  it('discovers the repository plugins in a stable order', () => {
    const plugins = discoverPlugins(repoRoot)
    assert.deepEqual(plugins.map((plugin) => plugin.dirName), ['app-restart', 'approval-allowlist', 'desktop-notify', 'notify-web'])
    for (const plugin of plugins) {
      assert.equal(plugin.packageName, `@local/${plugin.dirName}`)
      assert.equal(plugin.dir, join(repoRoot, plugin.dirName))
      assert.ok(plugin.surfaces.length > 0)
      assert.ok(plugin.platforms.length > 0)
    }
  })
})
