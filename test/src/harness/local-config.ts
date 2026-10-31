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
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  const entry = join(root, 'node_modules/@deepseek-ai/dsh/fake-dsh.cjs')
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const targetEntry = join(root, 'fake-dsh.cjs')
  writeFileSync(targetEntry, `#!/usr/bin/env node\nrequire(${JSON.stringify(entry)});\n`)
  const cli = process.platform === 'win32' ? join(root, 'dsh.cmd') : targetEntry
  if (process.platform === 'win32') writeFileSync(cli, '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-dsh.cjs" %*\r\n')
  else chmodSync(targetEntry, 0o755)
  mkdirSync(join(root, 'pnpm/bin'), { recursive: true })
  writeFileSync(join(root, 'pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.28.5' }))
  const pnpm = join(root, 'pnpm/bin/pnpm.cjs')
  writeFileSync(pnpm, '')
  const options = { pnpmScript: pnpm, browser: 'default' }
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5', devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } }))
  writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', bin: { dsh: './fake-dsh.cjs' } }))
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
