import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { commandEnv, configuredPnpm, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { discoverPlugins } from '../core/plugins.js'
import type { Plugin } from '../core/plugins.js'
import { runBuild } from './build.js'

export function requireBuilt(plugins: readonly Plugin[]): void {
  const missing = plugins.filter(plugin => !existsSync(join(plugin.dir, 'lib/index.js')))
  if (missing.length) throw new Error(`no build output in: ${missing.map(plugin => plugin.dirName).join(', ')}; run build first`)
}

export function runInherited(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, verbatim = false): number {
  const result = spawnSync(command, [...args], { cwd, env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: verbatim })
  if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`)
  return result.status ?? 1
}

export async function runPack(options: { skipBuild: boolean }, context: CommandContext = loadCommandContext()): Promise<number> {
  const pnpm = configuredPnpm(context)
  if (!options.skipBuild) {
    const code = await runBuild({ check: false }, context)
    if (code !== 0) return code
  }
  const plugins = discoverPlugins(context.root)
  if (!plugins.length) throw new Error('No plugin packages found.')
  requireBuilt(plugins)
  const dist = join(context.root, 'dist')
  mkdirSync(dist, { recursive: true })
  for (const plugin of plugins) {
    console.log(`· pack ${plugin.packageName}`)
    const code = runInherited(process.execPath, [pnpm, 'pack', '--pack-destination', dist], plugin.dir, commandEnv(context))
    if (code !== 0) return code
  }
  for (const file of readdirSync(dist).filter(name => name.endsWith('.tgz')).sort()) console.log(join(dist, file))
  return 0
}
