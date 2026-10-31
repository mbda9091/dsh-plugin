import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CommandContext } from './command-context.js'
import { commandEnv, operationTarget } from './command-context.js'
import type { InstallTarget } from './config.js'
import { envValue } from './config.js'
import { assertExternalDsh, requireFile, webDsh } from './config-tools.js'
import { resolveDsh } from './dsh-cli.js'
import { assertSeparatePaths, physicalPath } from './development.js'
import { digest, safeConfigPath } from './config-transaction.js'
import { discoverPlugins } from './plugins.js'
import { parseDocument } from 'yaml'
import { isRecord } from './json.js'

export interface TargetIdentity { cli: string; engine: string; entry: string; home: string; profile: string }

/** Read-only validation, repeated immediately before every target mutation. */
export function inspectTarget(context: CommandContext) {
  if (context.purpose !== 'target') throw new Error('explicit formal target required')
  const target = operationTarget(context)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(target.profile) || !['desktop', 'web'].includes(target.surface)) throw new Error('invalid target profile/surface')
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : null
  if (target.platform !== platform) throw new Error('target platform must match the current machine')
  if (target.profile === 'desktop' && target.surface !== 'desktop') throw new Error('desktop profile requires desktop surface')
  if (target.profile === 'web' && target.surface !== 'web') throw new Error('web profile requires web surface')
  if (!isAbsolute(target.home) || !isAbsolute(target.dshCli)) throw new Error('target paths must be absolute')
  const env = commandEnv(context)
  requireFile(target.dshCli, 'target.dshCli'); assertExternalDsh(target.dshCli, context.root, env)
  const runner = target.surface === 'web' ? webDsh(target.dshCli, env) : resolveDsh({ env: { ...env, DSH_CLI: target.dshCli } })
  if (runner.verbatim) throw new Error('opaque target wrapper is not supported; select a recognized Node/Electron entry')
  const directory = join(target.home, 'profiles', target.profile)
  // A redirected profile, manifest or node_modules container can write outside the selected home.
  for (const path of [directory, join(directory, 'package.json'), join(directory, 'pnpm-lock.yaml'), join(directory, 'pnpm-workspace.yaml'), join(directory, 'node_modules'), join(directory, 'node_modules/.modules.yaml')]) safeConfigPath(target.home, path)
  for (const protectedPath of ['.local', '.tmp', 'dist', 'node_modules', 'scripts', 'packages', 'profiles', 'test', 'docs']) assertSeparatePaths(target.home, join(context.root, protectedPath))
  for (const plugin of discoverPlugins(context.root)) assertSeparatePaths(target.home, plugin.dir)
  const entry = runner.build([]).find(arg => isAbsolute(arg)) ?? runner.command
  const identity: TargetIdentity = { cli: realpathSync(target.dshCli), engine: physicalPath(runner.command), entry: physicalPath(entry), home: physicalPath(target.home), profile: physicalPath(directory) }
  assertSeparatePaths(target.home, identity.cli)
  assertSeparatePaths(target.home, identity.entry)
  if (target.binding && Object.entries(identity).some(([key, value]) => target.binding![key as keyof TargetIdentity] !== value)) throw new Error('target binding changed real path; inspect and explicitly bind again')
  return { target, runner, directory, identity }
}

/** pnpm refuses changing stores under an existing node_modules. Preserve that
 * explicit on-disk association; new targets receive one stable isolated store. */
export function deliveryStore(context: CommandContext, inspected = inspectTarget(context)): string {
  const modules = join(inspected.directory, 'node_modules/.modules.yaml')
  let store = join(context.root, 'dist/target-stores', digest(inspected.identity.profile))
  if (existsSync(modules)) {
    const doc = parseDocument(readFileSync(modules, 'utf8')), value: unknown = doc.toJS()
    if (doc.errors.length || !isRecord(value) || typeof value.storeDir !== 'string' || !isAbsolute(value.storeDir) || basename(value.storeDir) !== 'v11') throw new Error('existing profile pnpm store is invalid or not v11; inspect its package-manager state before delivery')
    store = dirname(value.storeDir)
  }
  assertSeparatePaths(store, inspected.target.home)
  for (const path of ['.local', '.tmp', 'node_modules', 'scripts', 'packages', 'profiles', 'test', 'docs']) assertSeparatePaths(store, join(context.root, path))
  for (const plugin of discoverPlugins(context.root)) assertSeparatePaths(store, plugin.dir)
  return physicalPath(store)
}

/** Discovery is inventory only: no execution, no first-match selection or config writes. */
export function discoverTargets(root: string, env: NodeJS.ProcessEnv) {
  const candidates = (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean).flatMap(dir =>
    (process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat'] : ['dsh']).map(name => join(dir, name)))
  const local = envValue(env, 'LOCALAPPDATA')
  if (process.platform === 'win32' && local) candidates.push(join(local, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'))
  if (process.platform === 'darwin') candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
  const seen = new Set<string>(), accepted: { path: string; entry: string; engine: string }[] = [], rejected: { path: string; reason: string }[] = []
  for (const path of new Set(candidates.map(p => resolve(p)))) {
    if (!existsSync(path)) continue
    try {
      requireFile(path, 'candidate'); assertExternalDsh(path, root, env)
      const runner = resolveDsh({ env: { ...env, DSH_CLI: path } })
      if (runner.verbatim) throw new Error('unrecognized wrapper')
      const entry = physicalPath(runner.build([]).find(arg => isAbsolute(arg)) ?? runner.command)
      if (!seen.has(entry)) accepted.push({ path, entry, engine: runner.env.ELECTRON_RUN_AS_NODE ? 'electron' : runner.command === process.execPath ? 'node' : 'native' })
      seen.add(entry)
    } catch (error) { rejected.push({ path, reason: error instanceof Error ? error.message : 'invalid candidate' }) }
  }
  return { candidates: accepted, rejected }
}

export function targetContext(context: CommandContext, target: InstallTarget): CommandContext {
  return { ...context, purpose: 'target', target }
}
