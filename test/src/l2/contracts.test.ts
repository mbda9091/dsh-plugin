import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'
import { assertPackedFiles, assertPackedImport, packAndExtract } from '../harness/package.js'

/**
 * L2: package and contract checks, independent of the build pipeline.
 *
 * These tests read the repository as a consumer would: package metadata,
 * targets, bundle patch, locale prefix, packaged files, built entry point. They
 * intentionally re-derive the scenario prefix instead of calling the scripts,
 * so a bug in the generator cannot hide a broken package.
 */

interface PackageUnderTest {
  readonly dirName: string
  readonly dir: string
  readonly manifest: Record<string, unknown>
  readonly dsh: Record<string, unknown>
  readonly name: string
  readonly surfaces: string[]
  readonly platforms: string[]
  readonly patchPath: string
}

const ALLOWED_SURFACES = ['desktop', 'web']
const ALLOWED_PLATFORMS = ['windows', 'mac']
const SKIP_DIRS = new Set(['node_modules', 'dist'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  return value
}

function discover(): PackageUnderTest[] {
  const plugins: PackageUnderTest[] = []
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const dir = join(repoRoot, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue

    const manifest = record(readJson(manifestPath), manifestPath)
    const dsh = manifest['dsh']
    if (!isRecord(dsh) || dsh['bundle'] === undefined || dsh['bundle'] === null) continue

    const bundle = record(dsh['bundle'], `${entry.name}.dsh.bundle`)
    assert.equal(typeof bundle['patch'], 'string', `${entry.name}: dsh.bundle.patch must be a string`)
    const targets = record(dsh['targets'], `${entry.name}.dsh.targets`)

    plugins.push({
      dirName: entry.name,
      dir,
      manifest,
      dsh,
      name: typeof manifest['name'] === 'string' ? manifest['name'] : '',
      surfaces: stringArray(targets['surfaces']),
      platforms: stringArray(targets['platforms']),
      patchPath: join(dir, bundle['patch'] as string),
    })
  }
  return plugins.sort((left, right) => (left.dirName < right.dirName ? -1 : left.dirName > right.dirName ? 1 : 0))
}

/** The scenario prefix AGENTS.md requires at the start of meta.description. */
function scenarioPrefix(surfaces: readonly string[], platforms: readonly string[], language: 'zh' | 'en'): string {
  const surface = surfaces.includes('desktop') && surfaces.includes('web')
    ? (language === 'zh' ? '通用' : 'Universal')
    : surfaces.includes('desktop')
      ? (language === 'zh' ? '桌面' : 'Desktop')
      : surfaces.includes('web')
        ? 'Web'
        : (language === 'zh' ? '未声明' : 'Undeclared')
  const platform = platforms.includes('windows') && platforms.includes('mac')
    ? (language === 'zh' ? '通用平台' : 'All platforms')
    : platforms.includes('windows')
      ? 'Windows'
      : platforms.includes('mac')
        ? 'macOS'
        : (language === 'zh' ? '未声明' : 'Undeclared')
  return language === 'zh' ? `【${surface} · ${platform}】` : `[${surface} · ${platform}]`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(glob: string): RegExp {
  const parts = glob.split('/')
  let pattern = ''
  parts.forEach((part, index) => {
    const last = index === parts.length - 1
    if (part === '**') {
      pattern += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    pattern += part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    if (!last) pattern += '/'
  })
  return new RegExp(`^${pattern}$`)
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(relative(root, path).split(/[\\/]/).join('/'))
    }
  }
  walk(root)
  return files
}

const plugins = discover()

describe('L2 package contracts: discovery', () => {
  it('finds every top-level bundle package and nothing else', () => {
    assert.deepEqual(plugins.map((plugin) => plugin.dirName), ['app-restart', 'approval-allowlist', 'desktop-notify', 'notify-web'])
  })

  it('keeps directory name, package suffix and loader row id aligned', () => {
    for (const plugin of plugins) {
      assert.equal(plugin.name, `@local/${plugin.dirName}`)
      assert.match(readFileSync(plugin.patchPath, 'utf8'), new RegExp(`^\\s*- id: ${escapeRegExp(plugin.dirName)}$`, 'm'))
      assert.match(
        readFileSync(plugin.patchPath, 'utf8'),
        new RegExp(`^\\s+name: '${escapeRegExp(plugin.name)}'$`, 'm'),
        `${plugin.dirName}: bundle patch must insert this package`,
      )
    }
  })
})

for (const plugin of plugins) {
  describe(`L2 package contract: ${plugin.dirName}`, () => {
    it('has the required package metadata', () => {
      assert.equal(plugin.manifest['private'], true)
      assert.equal(plugin.manifest['type'], 'module')
      assert.match(plugin.name, /^@local\/[a-z0-9-]+$/)
      const version = plugin.manifest['version']
      assert.equal(typeof version, 'string')
      assert.match(version as string, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      const description = plugin.manifest['description']
      assert.equal(typeof description, 'string')
      assert.ok((description as string).length > 10)
    })

    it('declares a precise, supported target envelope', () => {
      const targets = record(plugin.dsh['targets'], 'dsh.targets')
      for (const key of Object.keys(targets)) {
        assert.ok(['surfaces', 'platforms'].includes(key), `${plugin.dirName}: unexpected dsh.targets field ${key}`)
      }
      assert.ok(plugin.surfaces.length > 0)
      assert.ok(plugin.platforms.length > 0)
      assert.equal(new Set(plugin.surfaces).size, plugin.surfaces.length)
      assert.equal(new Set(plugin.platforms).size, plugin.platforms.length)
      for (const surface of plugin.surfaces) assert.ok(ALLOWED_SURFACES.includes(surface), `bad surface ${surface}`)
      for (const platform of plugin.platforms) assert.ok(ALLOWED_PLATFORMS.includes(platform), `bad platform ${platform}`)
    })

    it('declares a client module only for the Web platform', () => {
      const client = plugin.dsh['client']
      if (client === undefined || client === null) return
      const section = record(client, 'dsh.client')
      assert.equal(section['platform'], 'web')
      if (section['inject'] !== undefined) {
        assert.ok(array(section['inject'], 'dsh.client.inject').every((item) => typeof item === 'string'))
      }
    })

    it('keeps both locales parseable and prefixed with the scenario', () => {
      for (const language of ['zh', 'en'] as const) {
        const path = join(plugin.dir, 'locale', `${language}.json`)
        assert.ok(existsSync(path), `${plugin.dirName}: missing ${path}`)
        const document = record(readJson(path), path)
        const meta = record(document['meta'], `${path}.meta`)
        assert.equal(typeof meta['title'], 'string')
        assert.ok((meta['title'] as string).trim().length > 0)
        assert.equal(typeof meta['description'], 'string')
        const description = meta['description'] as string
        assert.ok(
          description.startsWith(scenarioPrefix(plugin.surfaces, plugin.platforms, language)),
          `${plugin.dirName}: ${language} description must start with '${scenarioPrefix(plugin.surfaces, plugin.platforms, language)}'`,
        )
      }
    })

    it('packages every runtime file listed in files', () => {
      const files = stringArray(plugin.manifest['files'])
      assert.ok(files.length > 0, `${plugin.dirName}: files must be a non-empty array`)
      for (const required of ['cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
        assert.ok(files.includes(required), `${plugin.dirName}: files is missing ${required}`)
      }
      for (const entry of files) {
        if (!entry.includes('*')) {
          assert.ok(existsSync(join(plugin.dir, entry)), `${plugin.dirName}: files entry does not exist: ${entry}`)
          continue
        }
        const matcher = globToRegExp(entry)
        const matches = listFiles(plugin.dir).filter((file) => matcher.test(file))
        assert.ok(matches.length > 0, `${plugin.dirName}: files entry matches nothing: ${entry}`)
      }
    })

    it('exports the built entry, locales and icon', () => {
      const exportsField = record(plugin.manifest['exports'], 'exports')
      const root = record(exportsField['.'], 'exports["."]')
      assert.equal(root['types'], './lib/index.d.ts')
      assert.equal(root['default'], './lib/index.js')
      assert.ok(existsSync(join(plugin.dir, 'lib', 'index.d.ts')))
      assert.ok(existsSync(join(plugin.dir, 'lib', 'index.js')))
      assert.equal(exportsField['./locale/*.json'], './locale/*.json')
      assert.equal(exportsField['./icon'], './icon.svg')
      assert.ok(existsSync(join(plugin.dir, 'icon.svg')))
    })

    it('packs all compiled modules, resources and exports, and imports the extracted entry', () => {
      const directory = makeTempDir(`pack-${plugin.dirName}-`)
      try {
        const packed = packAndExtract(plugin.dir, directory)
        assertPackedFiles(plugin.dir, packed)
        assertPackedImport(packed, directory)
      } finally {
        removeDir(directory)
      }
    })

    it('rejects a tarball that omits lib even when the local build still imports', () => {
      const directory = makeTempDir(`pack-missing-${plugin.dirName}-`)
      try {
        const source = join(directory, 'source')
        cpSync(plugin.dir, source, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('node_modules') })
        const manifest = { ...plugin.manifest, files: stringArray(plugin.manifest['files']).filter((file) => !file.startsWith('lib/')) }
        writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
        assertPackedImport(source, directory)
        const packed = packAndExtract(source, join(directory, 'packed'))
        assert.throws(() => assertPackedFiles(source, packed), /tarball is missing runtime\/export file: lib\//)
      } finally {
        removeDir(directory)
      }
    })

    it('has a current build of all plugin and bundled workspace sources', () => {
      const built = statSync(join(plugin.dir, 'lib', 'index.js')).mtimeMs
      const inputs = listFiles(join(plugin.dir, 'src')).filter(file => file.endsWith('.ts'))
        .map(file => join(plugin.dir, 'src', file))
      if (existsSync(join(plugin.dir, 'build.json'))) {
        inputs.push(...listFiles(join(repoRoot, 'packages')).filter(file => /\/src\/.*\.ts$/.test(file))
          .map(file => join(repoRoot, 'packages', file)))
      }
      for (const source of inputs) {
        assert.ok(built >= statSync(source).mtimeMs, `${plugin.dirName}: build is older than ${source}; run the build`)
      }
    })

    it('loads through its package entry and exposes apply', async () => {
      const compiled = (await import(plugin.name)) as Record<string, unknown>
      assert.equal(typeof compiled['apply'], 'function', `${plugin.name} must export apply`)
      assert.equal(compiled['name'], plugin.dirName, `${plugin.name} must export the loader row id as name`)
      assert.equal(compiled['default'], undefined, `${plugin.name} must not export a default`)
      const inject = compiled['inject']
      if (inject !== undefined) {
        assert.ok(Array.isArray(inject))
        assert.ok((inject as unknown[]).every((item) => typeof item === 'string'))
      }
    })

    it('has a real icon and a README with the scenario section', () => {
      const icon = readFileSync(join(plugin.dir, 'icon.svg'))
      assert.ok(icon.length > 100)
      assert.ok(icon.length <= 256 * 1024)
      const text = icon.toString('utf8').trimStart()
      assert.ok(/^<svg[\s>]/i.test(text), `${plugin.dirName}: icon.svg must be an SVG`)
      assert.ok(!/TODO|placeholder/i.test(text), `${plugin.dirName}: icon.svg looks like a placeholder`)

      const readme = readFileSync(join(plugin.dir, 'README.md'), 'utf8')
      assert.match(readme, /^## 适用场景\s*$/m, `${plugin.dirName}: README must have a '## 适用场景' section`)
      assert.ok(readme.length > 200, `${plugin.dirName}: README is too short to document the plugin`)
    })
  })
}

describe('L2 package contracts: test fixtures', () => {
  const fixtures = join(repoRoot, 'test', 'fixtures')

  it('web-hello is a client-only Web fixture with a slot marker', () => {
    const manifest = record(readJson(join(fixtures, 'web-hello', 'package.json')), 'web-hello package.json')
    const dsh = record(manifest['dsh'], 'web-hello dsh')
    const targets = record(dsh['targets'], 'web-hello targets')
    assert.deepEqual(stringArray(targets['surfaces']), ['web'])
    assert.deepEqual(stringArray(targets['platforms']), ['windows', 'mac'])
    const client = record(dsh['client'], 'web-hello dsh.client')
    assert.equal(client['platform'], 'web')
    assert.equal(client['immediately'], true)

    const clientSource = readFileSync(join(fixtures, 'web-hello', 'client.js'), 'utf8')
    assert.ok(clientSource.includes('window.__ModuleLoader__.load'))
    assert.ok(clientSource.includes('conversation.composer.dock'))
    assert.ok(clientSource.includes('@local/web-hello'))
    assert.ok(!/require\(['"]@deepseek-ai\/dsh-client-/.test(clientSource))
  })

  it('target-mismatch declares a surface that can never match a real Host', () => {
    const manifest = record(readJson(join(fixtures, 'target-mismatch', 'package.json')), 'target-mismatch package.json')
    const dsh = record(manifest['dsh'], 'target-mismatch dsh')
    const targets = record(dsh['targets'], 'target-mismatch targets')
    assert.deepEqual(stringArray(targets['surfaces']), ['headless'])
    assert.deepEqual(stringArray(targets['platforms']), ['windows', 'mac'])

    const patch = readFileSync(join(fixtures, 'target-mismatch', 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /^\s*- id: target-mismatch$/m)
    assert.match(patch, /^\s+name: '@local\/target-mismatch'$/m)

    const source = readFileSync(join(fixtures, 'target-mismatch', 'index.js'), 'utf8')
    assert.ok(source.includes('target mismatch'))
  })
})
