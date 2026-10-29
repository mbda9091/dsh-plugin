import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPaths } from '../../../scripts/.build/core/config.js'
import { makeTempDir, repoRoot } from './tmp.js'

export function configFixture() {
  const root = makeTempDir("local config-中文-'quote")
  const paths = configPaths(root)
  for (const [source, destination] of [
    ['scripts/config/example.json', paths.example],
    ['scripts/config/schema.json', paths.schema],
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
  const options = { dshCli: cli, pnpmScript: pnpm, browser: 'default' }
  const env: NodeJS.ProcessEnv = { PATH: '', DSH_HOME: join(root, 'unused-home') }
  return { root, paths, entry, cli, options, env }
}
