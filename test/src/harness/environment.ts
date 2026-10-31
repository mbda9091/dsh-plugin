import assert from 'node:assert/strict'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it as test } from 'node:test'
import type { TestOptions } from 'node:test'
import { configPaths } from '../../../scripts/.build/core/config.js'
import { digest } from '../../../scripts/.build/core/config-transaction.js'

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
/** node:test run() does not filter in-process registrations on Node 24. */
export function environmentTest(name: string, optionsOrBody: TestOptions | (() => void | Promise<void>), body?: () => void | Promise<void>): void {
  const selected = process.env.DSH_ENV_TEST_ONLY?.split(',')
  if (selected && !selected.includes(name.split(' ')[0]!)) return
  if (typeof optionsOrBody === 'function') test(name, optionsOrBody)
  else test(name, optionsOrBody, body)
}
export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  function visit(path: string, key: string): void {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) result[key] = `link:${readlinkSync(path)}`
    else if (stat.isDirectory()) { result[key] = 'directory'; for (const child of readdirSync(path).sort()) visit(join(path, child), `${key}/${child}`) }
    else result[key] = digest(readFileSync(path))
  }
  visit(root, '.')
  return result
}

export async function environmentCase(id: string, body: (f: ReturnType<typeof fixture>) => void | Promise<void>, captureWorkspace = true): Promise<void> {
  const base = process.env.DSH_ENV_TEST_RUN
  assert.ok(base, 'use test-env runner')
  const f = fixture(base)
  const before = snapshot(f.root)
  let after: Record<string, string> | undefined
  let passed = false
  let cleanup = 'retained failure'
  try {
    await body(f)
    assert.deepEqual(snapshot(f.personal), f.personalBefore)
    after = captureWorkspace ? snapshot(f.root) : { scope: 'real suite: dependency trees omitted; assertions and command evidence recorded separately' }
    if (process.env.DSH_ENV_TEST_KEEP !== '1') { rmSync(f.root, { recursive: true }); cleanup = 'removed owned fixture (links not followed)' }
    else cleanup = 'retained --keep'
    passed = true
  } finally {
    writeFileSync(join(base, `${id}.json`), JSON.stringify({ id, passed, cleanup, fixture: f.root, personalSentinelsUnchanged: passed, before, after }, null, 2))
  }
}

export function fixture(base: string) {
  const root = mkdtempSync(join(base, 'repo 中文 space-'))
  const paths = configPaths(root)
  mkdirSync(dirname(paths.local), { recursive: true })
  mkdirSync(dirname(paths.patch), { recursive: true })
  for (const name of ['schema.json', 'schema.v1.json', 'example.json']) copyFileSync(join(sourceRoot, 'scripts/config', name), join(root, 'scripts/config', name))
  const personal = join(root, 'simulated-user')
  mkdirSync(personal)
  for (const name of ['session.json', 'credentials.txt', 'patch.yml']) writeFileSync(join(personal, name), `fake sentinel ${name}`)
  const personalBefore = snapshot(personal)
  const config = JSON.parse(readFileSync(paths.example, 'utf8'))
  const write = (value: unknown = config) => writeFileSync(paths.local, JSON.stringify(value, null, 2))
  const legacy = () => {
    const old = { version: 1, tools: { dshCli: 'old-private-cli', pnpmScript: null }, web: { ...config.web, browserPath: 'custom browser', startupTimeoutMs: 9999 }, test: { ...config.test, timeoutMs: 4567 } }
    write(old)
    writeFileSync(paths.patch, '# personal YAML must stay byte exact\r\nsecret: fake-token\r\n')
    return old
  }
  const fake = () => {
    const directory = join(root, 'node_modules/@deepseek-ai/dsh')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5', devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } }))
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', bin: { dsh: './cli.cjs' } }))
    const entry = join(directory, 'cli.cjs')
    writeFileSync(entry, `const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({node:process.execPath,args:process.argv.slice(3),home:process.env.DSH_HOME,profile:process.env.DSH_PROFILE,cli:process.env.DSH_CLI,store:process.env.PNPM_CONFIG_STORE_DIR||process.env.pnpm_config_store_dir}));`)
    return entry
  }
  return { root, paths, personal, personalBefore, config, write, legacy, fake }
}
