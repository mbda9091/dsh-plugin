import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { commandEnv, configuredDsh, configuredPnpm, loadCommandContext, operationTarget } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { discoverPlugins } from '../core/plugins.js'
import { writePnpmShim } from '../core/pnpm.js'
import { formatPluginTarget, isTargetCompatible, resolveTarget } from '../core/targets.js'
import type { TargetOptions } from '../core/targets.js'
import { requireBuilt, runInherited } from './pack.js'
import { runBuild } from './build.js'
import { acquireDevelopmentLock, initializeDevelopment, recordDevelopmentLinks, verifyDevelopmentLinks, validateDevelopmentPaths, developmentEnvironment } from '../core/development.js'
import { runArtifactInstall } from './install-artifacts.js'

export interface InstallOptions extends TargetOptions {
  readonly mode: 'link' | 'tarball'
  readonly dryRun: boolean
  readonly skipBuild: boolean
  readonly all: boolean
  readonly manifest?: string | undefined
  readonly only?: string | undefined
}

/** Plan before side effects: a missing later archive must not leave a partially
 * switched profile. Only add-over/update are allowed; never remove link targets.
 */
export async function runInstall(options: InstallOptions, context: CommandContext = loadCommandContext()): Promise<number> {
  validateDevelopmentPaths(context)
  if (options.mode === 'tarball') return runArtifactInstall(options, context)
  if (options.manifest) throw new Error('--manifest is only for tarball installation')
  if (options.only) throw new Error('--only is only for tarball installation')
  if (options.dryRun) return install(options, context)
  const release = acquireDevelopmentLock(context)
  try { return await install(options, context) } finally { release() }
}

async function install(options: InstallOptions, context: CommandContext): Promise<number> {
  const selectedTarget = operationTarget(context)
  if (options.mode === 'link' && context.purpose !== 'development') throw new Error('link installation is restricted to development context')
  const profile = selectedTarget.profile
  const target = resolveTarget(selectedTarget)
  const directory = join(selectedTarget.home, 'profiles', profile)
  const plugins = discoverPlugins(context.root)
  if (!plugins.length) throw new Error('No plugin packages found.')
  const selected = plugins.filter(plugin => options.all || isTargetCompatible(plugin, target))
  console.log(`target: ${target.surface}/${target.platform}; profile: ${profile} (${options.mode} mode)`)
  for (const plugin of plugins.filter(plugin => !selected.includes(plugin))) {
    console.log(`· skip ${plugin.packageName}: requires ${formatPluginTarget(plugin)}`)
  }
  if (!selected.length) { console.log('no compatible plugins; nothing changed'); return 0 }
  const runner = configuredDsh(context, target.surface === 'web')
  const pnpm = configuredPnpm(context)
  const plan = selected.map(plugin => ({ plugin, location: plugin.dir }))
  if (options.dryRun) {
    for (const item of plan) {
      console.log(`dsh plugin --profile ${profile} add ${JSON.stringify(item.location)}`)
      console.log(`(${directory}) pnpm update ${item.plugin.packageName}`)
    }
    console.log('dry run: nothing changed (a link install builds first unless --skip-build)')
    return 0
  }
  if (options.mode === 'link') {
    if (!options.skipBuild) {
      const code = await runBuild({ check: false }, context)
      if (code !== 0) return code
    }
    requireBuilt(selected)
    initializeDevelopment(context)
    recordDevelopmentLinks(context, selected)
  }
  const scratch = join(context.root, '.tmp/install')
  mkdirSync(scratch, { recursive: true })
  const runDir = mkdtempSync(join(scratch, 'run-'))
  try {
    writePnpmShim(runDir, pnpm)
    const env = { ...(options.mode === 'link' ? developmentEnvironment(context) : commandEnv(context)), ...runner.env }
    // Resolve the requested profile before changing the child's session name.
    for (const key of Object.keys(env)) {
      if (['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL'].includes(key.toUpperCase())) delete env[key]
    }
    env.DSH_PROFILE = profile
    env.DSH_PROFILE_DIR = directory
    env.PATH = `${runDir}${delimiter}${env.PATH ?? ''}`
    for (const item of plan) {
      console.log(`· add ${item.plugin.packageName}`)
      const installed = runInherited(runner.command, runner.build(['plugin', '--profile', profile, 'add', item.location]), context.root, env, runner.verbatim)
      if (installed !== 0) return installed
      // A spec change alone can leave a stale junction/lock resolution.
      const updated = runInherited(process.execPath, [pnpm, 'update', item.plugin.packageName], directory, env)
      if (updated !== 0) return updated
      if (options.mode === 'link') verifyDevelopmentLinks(context, [item.plugin])
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
  console.log(`installed ${selected.length} plugin(s); restart DSH if loaded Host code changed`)
  return 0
}
