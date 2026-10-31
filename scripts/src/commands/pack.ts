import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactLock, describeArtifact, newBatch, publishManifest, sourceState } from '../core/artifacts.js'
import { expectedPnpm } from '../core/toolchain.js'
import { packageEnvironment, preparePackageEnvironment } from '../core/test-isolation.js'
import { checkPackedSource, readPackage } from '../core/artifact-package.js'
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

export async function runPack(options: { skipBuild: boolean }, context: CommandContext = loadCommandContext(), onManifest?: (path: string) => void): Promise<number> {
  const release = artifactLock(context.root)
  try { return await pack(options, context, onManifest) } finally { release() }
}

async function pack(options: { skipBuild: boolean }, context: CommandContext, onManifest?: (path: string) => void): Promise<number> {
  const pnpm = configuredPnpm(context)
  if (!options.skipBuild) {
    const code = await runBuild({ check: false }, context)
    if (code !== 0) return code
  }
  const plugins = discoverPlugins(context.root)
  if (!plugins.length) throw new Error('No plugin packages found.')
  requireBuilt(plugins)
  const source = sourceState(context.root)
  const { batch, directory: dist } = newBatch(context.root)
  const packageConfig = join(dist, '.pack')
  preparePackageEnvironment(packageConfig)
  const packages = []
  for (const plugin of plugins) {
    console.log(`· pack ${plugin.packageName}`)
    const code = runInherited(process.execPath, [pnpm, 'pack', '--pack-destination', dist], plugin.dir, packageEnvironment(commandEnv(context), packageConfig))
    if (code !== 0) return code
    const path = `${plugin.packageName.replace(/^@/, '').replaceAll('/', '-')}-${plugin.version}.tgz`
    const artifact = describeArtifact(join(dist, path), path)
    checkPackedSource(plugin.dir, readPackage(readFileSync(join(dist, path))))
    if (artifact.name !== plugin.packageName || artifact.version !== plugin.version) throw new Error('packed identity differs from source')
    packages.push(artifact)
  }
  if (JSON.stringify(sourceState(context.root)) !== JSON.stringify(source)) throw new Error('source changed during pack')
  const manifest = publishManifest(context.root, { version: 1, batch, createdAt: new Date().toISOString(), source,
    tools: { node: process.version, pnpm: expectedPnpm(context.root) }, packages })
  console.log(`artifact manifest: ${manifest}`); onManifest?.(manifest)
  for (const file of readdirSync(dist).filter(name => name.endsWith('.tgz')).sort()) console.log(join(dist, file))
  return 0
}
