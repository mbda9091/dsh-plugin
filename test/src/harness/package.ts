import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, matchesGlob, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolvePnpmScript } from '../../../scripts/.build/commands/l4.js'
import { runToFiles } from '../../../scripts/.build/core/exec.js'

/** Metadata shape already validated by the package contract suite. */
interface Manifest {
  name: string
  version: string
  type: string
  exports: { '.': { default: string }; [key: string]: unknown }
  dsh: { bundle: { patch: string } }
}

export function packageFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  walk(root)
  return files
}

/** Use the real package manager and archive, not a second implementation of files filtering. */
export function packAndExtract(source: string, destination: string): string {
  mkdirSync(destination, { recursive: true })
  const pack = runToFiles(process.execPath, [resolvePnpmScript(), 'pack', '--pack-destination', destination], {
    cwd: source,
    timeoutMs: 120_000,
    stdoutPath: join(destination, 'pack.out.log'),
    stderrPath: join(destination, 'pack.err.log'),
  })
  assert.equal(pack.status, 0, `pnpm pack failed:\n${pack.stdout}\n${pack.stderr}`)
  const archives = readdirSync(destination).filter((name) => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'pack must produce exactly one tarball')
  const extract = runToFiles('tar', ['-xzf', join(destination, archives[0]!), '-C', destination], {
    timeoutMs: 30_000,
    stdoutPath: join(destination, 'extract.out.log'),
    stderrPath: join(destination, 'extract.err.log'),
  })
  assert.equal(extract.status, 0, `tar extraction failed (tar must be on PATH):\n${extract.stderr}`)
  return join(destination, 'package')
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(exportTargets)
}

/** All compiled modules/resources and every export target must survive packing unchanged. */
export function assertPackedFiles(source: string, packed: string): void {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest
  const packedManifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')) as Manifest
  for (const key of ['name', 'version', 'type', 'exports', 'dsh'] as const) {
    assert.deepEqual(packedManifest[key], manifest[key], `packed package.json changed ${key}`)
  }
  const sourceFiles = packageFiles(source)
  const packedFiles = new Set(packageFiles(packed))
  const required = new Set([
    'README.md',
    manifest.dsh.bundle.patch.replace(/^\.\//, ''),
    ...sourceFiles.filter((file) => file.startsWith('lib/') || file.startsWith('locale/')),
  ])
  for (const target of exportTargets(manifest.exports)) {
    assert.ok(target.startsWith('./'), `export must be package-relative: ${target}`)
    const matches = sourceFiles.filter((file) => matchesGlob(file, target.slice(2)))
    assert.ok(matches.length > 0, `export target does not exist: ${target}`)
    for (const file of matches) required.add(file)
  }
  for (const file of required) {
    assert.ok(packedFiles.has(file), `tarball is missing runtime/export file: ${file}`)
    assert.deepEqual(readFileSync(join(packed, file)), readFileSync(join(source, file)), `packed file differs: ${file}`)
  }
}

/** Import the extracted entry in fresh processes, so repository module caches cannot hide missing files. */
export function assertPackedImport(packed: string, logDir: string): void {
  const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')) as Manifest
  const entry = pathToFileURL(join(packed, manifest.exports['.'].default)).href
  const script = `import assert from 'node:assert/strict';
    const plugin = await import(${JSON.stringify(entry)});
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(plugin.name, ${JSON.stringify(manifest.name.split('/').at(-1))});
    assert.equal(plugin.default, undefined);`
  for (const preserve of [false, true]) {
    const result = runToFiles(process.execPath, [
      ...(preserve ? ['--preserve-symlinks'] : []), '--input-type=module', '--eval', script,
    ], {
      cwd: packed,
      timeoutMs: 30_000,
      stdoutPath: join(logDir, `import-${preserve}.out.log`),
      stderrPath: join(logDir, `import-${preserve}.err.log`),
    })
    assert.equal(result.status, 0, `packed entry import failed (preserve-symlinks=${preserve}):\n${result.stderr}`)
  }
}
