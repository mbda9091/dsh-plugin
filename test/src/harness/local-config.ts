import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renderWebPatch } from '../../../scripts/.build/core/web-patch.js'
import { dirname, join } from 'node:path'
import { configPaths } from '../../../scripts/.build/core/config.js'
import { makeTempDir, repoRoot } from './tmp.js'

export function configFixture() {
  const root = makeTempDir("local config-中文-'quote")
  const paths = configPaths(root)
  for (const [source, destination] of [
    ['scripts/config/example.json', paths.example],
    ['scripts/config/schema.json', paths.schema],
    ['scripts/config/schema.v1.json', join(root, 'scripts/config/schema.v1.json')],
    ['profiles/web/cordis.patch.example.yml', paths.patchExample],
  ]) {
    mkdirSync(dirname(destination!), { recursive: true })
    copyFileSync(join(repoRoot, source!), destination!)
  }
  const entry = join(root, 'fake-dsh.cjs')
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const cli = process.platform === 'win32' ? join(root, 'dsh.cmd') : entry
  if (process.platform === 'win32') writeFileSync(cli, '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-dsh.cjs" %*\r\n')
  else chmodSync(entry, 0o755)
  const pnpm = join(root, 'pnpm.cjs')
  writeFileSync(pnpm, '')
  const options = { pnpmScript: pnpm, browser: 'default' }
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } }))
  writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.1-rc.2', bin: { dsh: '../../../fake-dsh.cjs' } }))
  const env: NodeJS.ProcessEnv = { PATH: '', DSH_HOME: join(root, 'unused-home') }
  return { root, paths, entry, cli, options, env }
}

/** Explicit managed data fixture; config init must never create/import it. */
export function developmentPatch(f: ReturnType<typeof configFixture>): string {
  const path = join(f.root, '.local/dsh-dev/cordis.patch.yml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderWebPatch(readFileSync(f.paths.patchExample, 'utf8'), f.root))
  return path
}
