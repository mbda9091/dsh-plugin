import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configuredPnpm, loadCommandContext } from '../core/command-context.js'
import { inspectTarget } from '../core/formal-target.js'
import { dailyHash, plainPath, readDailyConfig, separateDaily, validateDailyLocation, validateDailyTools } from '../core/daily-contract.js'
import type { DailyConfig } from '../core/daily-contract.js'
import { pnpmVersion } from '../core/toolchain.js'
import { sourceState } from '../core/artifacts.js'
import { repoRoot } from '../core/repo.js'
import { resolveEsbuild } from './build.js'

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'
export function buildDailyRelease(output: string, sourceRoot = repoRoot): { release: string; files: Record<string, string> } {
  plainPath(output); mkdirSync(output, { recursive: true })
  for (const entry of ['launcher', 'dispatch']) {
    const result = spawnSync(resolveEsbuild(), [join(sourceRoot, `packages/daily-launcher/src/${entry}.ts`), '--bundle', '--platform=node', '--format=esm', '--target=node24', `--outfile=${join(output, `${entry}.mjs`)}`, `--metafile=${join(output, `${entry}.meta.json`)}`, '--log-level=warning'], { stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error('daily launcher bundle failed')
    const meta = JSON.parse(readFileSync(join(output, `${entry}.meta.json`), 'utf8'))
    for (const item of Object.values(meta.outputs) as { imports: { path: string; external?: boolean }[] }[]) if (item.imports.some(i => i.external && !i.path.startsWith('node:'))) throw new Error('launcher has a non-builtin runtime dependency')
  }
  const files = Object.fromEntries(['launcher.mjs', 'dispatch.mjs'].map(name => [name, dailyHash(readFileSync(join(output, name)))]))
  return { release: files['launcher.mjs']!, files }
}

export function publishDaily(candidate: string, destination: string, config: DailyConfig, hooks: { beforeActivate?: () => void } = {}): void {
  validateDailyLocation(destination, config)
  validateDailyTools(config)
  const manifest = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || !/^[a-f\d]{64}$/.test(manifest.release) || manifest.files?.['launcher.mjs'] !== manifest.release) throw new Error('invalid launcher candidate')
  const files = ['launcher.mjs', 'dispatch.mjs']
  for (const name of files) if (dailyHash(readFileSync(join(candidate, name))) !== manifest.files[name]) throw new Error('launcher candidate hash mismatch')
  for (const name of files) {
    const checked = spawnSync(config.host.node, ['--check', join(candidate, name)], { stdio: 'inherit' })
    if (checked.error || checked.status !== 0) throw new Error('launcher candidate syntax check failed')
  }
  const activePath = join(destination, 'active.json'), lock = join(destination, 'deploy.lock')
  for (const path of [activePath, lock]) plainPath(path)
  mkdirSync(destination, { recursive: true })
  writeFileSync(lock, json({ pid: process.pid }), { flag: 'wx' })
  try {
    const previous = existsSync(activePath) ? readFileSync(activePath, 'utf8') : null
    if (previous) {
      const old = JSON.parse(previous), oldConfig = readDailyConfig(join(destination, 'config', old.config))
      if (oldConfig.instanceId !== config.instanceId) throw new Error('instance identity changed during deployment')
      if (JSON.stringify(oldConfig.target) !== JSON.stringify(config.target) || JSON.stringify(oldConfig.host) !== JSON.stringify(config.host)) {
        if (existsSync(join(destination, 'state', config.instanceId, 'runtime.json')) || existsSync(join(destination, 'state', config.instanceId, 'operation.lock'))) throw new Error('target/host identity change requires stopped instance and resolved runtime record')
      }
    }
    const id = randomUUID(), configName = `daily-${id}.json`
    const immutable = (path: string, bytes: string | Buffer) => {
      plainPath(path); mkdirSync(dirname(path), { recursive: true })
      if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
      if (dailyHash(readFileSync(path)) !== dailyHash(bytes)) throw new Error('existing release differs; refusing overwrite')
    }
    immutable(join(destination, 'releases', manifest.release, 'launcher.mjs'), readFileSync(join(candidate, 'launcher.mjs')))
    immutable(join(destination, 'releases', manifest.release, 'manifest.json'), json({ version: 1, release: manifest.release, files: manifest.files }))
    immutable(join(destination, 'config', configName), json(config))
    // Dispatch is protocol-v1 fixed; updates cannot replace code used by old pointers.
    immutable(join(destination, 'bin/dshweb.mjs'), readFileSync(join(candidate, 'dispatch.mjs')))
    const quote = (s: string) => s.replaceAll("'", "''")
    immutable(join(destination, 'bin/dshweb.ps1'), `& '${quote(config.host.node)}' '${quote(join(destination, 'bin/dshweb.mjs'))}' @args\nexit $LASTEXITCODE\n`)
    immutable(join(destination, 'bin/shell-integration.txt'), `function global:dshweb { & '${quote(config.host.node)}' '${quote(join(destination, 'bin/dshweb.mjs'))}' @args }\n`)
    const active = { version: 1, release: manifest.release, config: configName, configSha256: dailyHash(json(config)) }
    immutable(join(destination, 'receipts', id, 'deployment.json'), json({ version: 1, createdAt: new Date().toISOString(), previous: previous ? JSON.parse(previous) : null, next: active, manifest }))
    hooks.beforeActivate?.()
    const next = join(destination, `active-${id}.json`); plainPath(next); plainPath(activePath)
    if ((existsSync(activePath) ? readFileSync(activePath, 'utf8') : null) !== previous) throw new Error('active pointer changed during deploy')
    writeFileSync(next, json(active), { flag: 'wx' }); renameSync(next, activePath)
  } finally { plainPath(lock); unlinkSync(lock) }
}

export async function runDailyLauncher(args: string[], root = repoRoot, env = process.env): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { target: { type: 'string' }, destination: { type: 'string' }, 'dry-run': { type: 'boolean' } } })
  const action = positionals[0]
  if (positionals.length !== 1 || !['prepare', 'deploy'].includes(action ?? '') || !values.target || !values.destination) throw new Error('daily-launcher prepare|deploy --target NAME --destination ABSOLUTE_PATH [--dry-run]')
  const context = loadCommandContext({ target: values.target }, root, env, 'target')
  const { target, identity } = inspectTarget(context), pnpm = configuredPnpm(context)
  if (process.platform !== 'win32' || target.surface !== 'web') throw new Error('daily launcher currently supports Windows Web only')
  const destination = resolve(values.destination)
  if (!isAbsolute(values.destination)) throw new Error('--destination must be absolute')
  separateDaily(destination, [root, target.home]); separateDaily(target.home, [root])
  const activePath = join(destination, 'active.json'); plainPath(activePath)
  const previous = existsSync(activePath) ? JSON.parse(readFileSync(activePath, 'utf8')) : null
  const before = previous ? readDailyConfig(join(destination, 'config', previous.config)) : null
  const hostManifest = join(dirname(dirname(identity.entry)), 'package.json')
  const metadata = JSON.parse(readFileSync(hostManifest, 'utf8'))
  if (metadata.name !== '@deepseek-ai/dsh' || typeof metadata.version !== 'string') throw new Error('selected DSH must use its installed package lib/bin.js entry')
  const config: DailyConfig = {
    version: 1, instanceId: before?.instanceId ?? randomUUID(),
    host: { node: realpathSync(process.execPath), nodeVersion: process.versions.node, cli: identity.cli, entry: identity.entry, version: metadata.version,
      hashes: Object.fromEntries([realpathSync(process.execPath), identity.cli, identity.entry, hostManifest].map(p => [p, dailyHash(readFileSync(p))])) },
    target: { home: identity.home, profile: target.profile, directory: identity.profile, surface: 'web', platform: 'windows' },
    packageManager: { script: realpathSync(pnpm), version: pnpmVersion(pnpm), sha256: dailyHash(readFileSync(pnpm)) },
    web: { host: '127.0.0.1', port: 3080, ...context.config.web },
    isolation: { forbiddenRoots: [realpathSync(root), join(realpathSync(root), '.local/dsh-dev'), join(realpathSync(root), '.tmp')] },
  }
  validateDailyLocation(destination, config); validateDailyTools(config)
  if (!existsSync(join(config.target.directory, 'package.json'))) throw new Error('daily requires an existing initialized profile')
  console.log(json({ action, destination, before, after: config, files: ['bin/', 'releases/', 'config/', 'active.json', 'receipts/'], dryRun: !!values['dry-run'] }))
  if (values['dry-run']) return 0
  const candidate = join(root, 'dist/daily-launcher', randomUUID())
  const built = buildDailyRelease(candidate)
  writeFileSync(join(candidate, 'manifest.json'), json({ version: 1, ...built, source: sourceState(root), node: process.version, dsh: config.host.version, pnpm: config.packageManager.version, platform: 'windows', surface: 'web' }))
  writeFileSync(join(candidate, 'daily.json'), json(config))
  if (action === 'deploy') {
    publishDaily(candidate, destination, config)
    const locator = join(root, '.local/dsh-daily', values.target, 'deployment.json'); plainPath(locator); mkdirSync(dirname(locator), { recursive: true })
    writeFileSync(locator, json({ destination, node: config.host.node }))
  }
  console.log(`${action === 'deploy' ? 'deployed' : 'prepared'} daily launcher: ${candidate}`)
  return 0
}
