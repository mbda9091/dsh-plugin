import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { it } from 'node:test'
import { workspaceDsh, checkNode, checkPnpm } from '../../../../scripts/.build/core/toolchain.js'
import { assertExternalDsh, discoverDsh } from '../../../../scripts/.build/core/config-tools.js'
import { configuredDsh, loadCommandContext } from '../../../../scripts/.build/core/command-context.js'
import { discoverPnpmScript, writePnpmShim } from '../../../../scripts/.build/core/pnpm.js'
import { toolDiagnostics } from '../../../../scripts/.build/commands/config.js'
import { runToFiles } from '../../../../scripts/.build/core/exec.js'
import { discoverPlugins } from '../../../../scripts/.build/core/plugins.js'
import { resolveDsh } from '../../../../scripts/.build/core/dsh-cli.js'
import { environmentCase, sourceRoot } from '../../harness/environment.js'

it('TOOL-01 workspace host is exact, never falls back, target aliases excluded', () => environmentCase('TOOL-01', f => {
  const entry = f.fake()
  const runner = workspaceDsh(f.root)
  assert.equal(runner.source, realpathSync(entry))
  assert.equal(runner.command, process.execPath)
  const alias = join(f.root, 'alias')
  symlinkSync(dirname(entry), alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertExternalDsh(join(alias, 'cli.cjs'), f.root, {}), /workspace development/)
  assert.throws(() => assertExternalDsh(entry, f.root, {}), /workspace development/)
  const localBin = join(f.root, 'node_modules/.bin')
  const external = join(f.root, 'external'); mkdirSync(localBin); mkdirSync(external)
  const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const externalEntry = join(external, 'cli.cjs'); writeFileSync(externalEntry, '#!/usr/bin/env node\n')
  if (process.platform === 'win32') {
    writeFileSync(join(localBin, name), `"%~dp0\\node.exe" "${entry}" %*`)
    writeFileSync(join(external, name), `"%~dp0\\node.exe" "${externalEntry}" %*`)
  } else {
    symlinkSync(entry, join(localBin, name)); symlinkSync(externalEntry, join(external, name))
  }
  const env = { PATH: [localBin, external].join(delimiter), DSH_CLI: externalEntry, ELECTRON_RUN_AS_NODE: '1' }
  f.write()
  assert.equal(configuredDsh(loadCommandContext({}, f.root, env, 'development'), true).source, realpathSync(entry))
  assert.equal(discoverDsh(null, env, f.root).path, join(external, name))
  rmSync(entry)
  assert.throws(() => workspaceDsh(f.root), /bin is missing/)
  const old = process.env.DSH_CLI
  try {
    process.env.DSH_CLI = process.execPath
    rmSync(join(dirname(entry), 'package.json'))
    assert.throws(() => workspaceDsh(f.root), /no fallback/)
  } finally { if (old === undefined) delete process.env.DSH_CLI; else process.env.DSH_CLI = old }
}))

it('TOOL-02 wrong versions/entries fail; optional tools do not block diagnostics', () => environmentCase('TOOL-02', f => {
  const entry = f.fake()
  for (const version of ['22.1.0', '25.0.0']) assert.throws(() => checkNode(version), /ordinary Node 24/)
  assert.throws(() => checkNode('24.1.0', '39.0.0'), /Electron/)
  checkNode('24.1.0', undefined)
  const pkg = join(dirname(entry), 'package.json')
  const rootManifest = join(f.root, 'package.json')
  const original = readFileSync(rootManifest)
  writeFileSync(rootManifest, JSON.stringify({ devDependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.2' } }))
  assert.throws(() => workspaceDsh(f.root), /exact declared/)
  writeFileSync(rootManifest, original)
  writeFileSync(pkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1', bin: 'cli.cjs' }))
  assert.throws(() => workspaceDsh(f.root), /exact declared/)
  const script = join(f.root, 'pnpm/bin/pnpm.cjs')
  mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, '')
  const manifest = join(f.root, 'pnpm/package.json')
  writeFileSync(manifest, JSON.stringify({ name: 'pnpm', version: '10.0.0' }))
  assert.throws(() => checkPnpm(script, f.root), /does not match/)
  writeFileSync(manifest, JSON.stringify({ name: 'pnpm', version: '11.28.5' }))
  assert.equal(checkPnpm(script, f.root), realpathSync(script))
  assert.throws(() => checkPnpm(join(f.root, 'absent.cjs'), f.root), /invalid pnpm/)
  assert.equal(discoverPnpmScript({ DSH_HOME: f.personal, PATH: '' }), null)
  const prefix = join(f.root, 'prefix')
  mkdirSync(join(prefix, 'node_modules'), { recursive: true })
  symlinkSync(join(f.root, 'pnpm'), join(prefix, 'node_modules/pnpm'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(realpathSync(discoverPnpmScript({ PATH: prefix })!), realpathSync(script))
  const diagnostic = toolDiagnostics(f.root, null).join('\n')
  assert.match(diagnostic, /Node: v24/); assert.match(diagnostic, /pnpm: unavailable/); assert.match(diagnostic, /DSH: unavailable/)
}))

it('TOOL-03 current Node drives DSH and pnpm shim; Electron retains its engine', () => environmentCase('TOOL-03', f => {
  const entry = f.fake()
  const runner = workspaceDsh(f.root)
  const record = join(f.root, 'node.json')
  const run = runToFiles(runner.command, runner.build([record]), { env: { ...process.env, PATH: '' }, stdoutPath: join(f.root, 'out'), stderrPath: join(f.root, 'err') })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).node, process.execPath)
  const bin = join(f.root, 'bin'); writePnpmShim(bin, entry)
  const command = process.platform === 'win32' ? process.env.ComSpec! : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `""${join(bin, 'pnpm.cmd')}" "${record}""`] : [join(bin, 'pnpm'), record]
  const shim = runToFiles(command, args, { env: { ...process.env, PATH: ['unrelated-node', bin].join(delimiter) }, verbatim: process.platform === 'win32', stdoutPath: join(f.root, 'shim.out'), stderrPath: join(f.root, 'shim.err') })
  assert.equal(shim.status, 0, shim.stderr)
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).node, process.execPath)
  const wrapper = join(f.root, 'electron.cmd')
  writeFileSync(wrapper, `"${process.execPath}" --expose-internals "${entry}"`)
  const desktop = resolveDsh({ platform: 'win32', env: { DSH_CLI: wrapper } })
  assert.equal(desktop.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(desktop.build([])[0], '--expose-internals')
  assert.match(readFileSync(join(sourceRoot, 'scripts/bootstrap.mjs'), 'utf8'), /spawnSync\(process.execPath/)
}))

it('TOOL-05 DSH belongs only to root development dependencies', () => environmentCase('TOOL-05', () => {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh'], '0.2.1-rc.2')
  assert.equal(manifest.dependencies, undefined)
  for (const plugin of discoverPlugins(sourceRoot)) {
    assert.equal(plugin.manifest.dependencies, undefined)
    assert.equal((plugin.manifest.devDependencies as Record<string, string>)['@deepseek-ai/dsh'], undefined)
  }
}))
