import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { commandEnv, configuredDsh, configuredPnpm, loadCommandContext, operationTarget } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { discoverPlugins } from '../core/plugins.js'
import { writePnpmShim } from '../core/pnpm.js'
import { formatPluginTarget, isTargetCompatible, resolveTarget } from '../core/targets.js'
import type { TargetOptions } from '../core/targets.js'
import { requireBuilt, runInherited } from './pack.js'
import { runBuild } from './build.js'

export interface InstallOptions extends TargetOptions {
  readonly mode: 'link' | 'tarball'
  readonly dryRun: boolean
  readonly skipBuild: boolean
  readonly all: boolean
}

/** Plan before side effects: a missing later archive must not leave a partially
 * switched profile. Only add-over/update are allowed; never remove link targets.
 */
export async function runInstall(options: InstallOptions, context: CommandContext = loadCommandContext()): Promise<number> {
  const selectedTarget = operationTarget(context)
  if (options.mode === 'link' && context.purpose !== 'development') throw new Error('link installation is restricted to development context')
  if (options.mode === 'tarball' && context.purpose !== 'target') throw new Error('tarball installation requires an explicit target')
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
  const dist = resolve(context.root, 'dist')
  const plan = selected.map(plugin => {
    const archive = resolve(dist, `${plugin.packageName.replace(/^@/, '').replaceAll('/', '-')}-${plugin.version}.tgz`)
    const inside = relative(dist, archive)
    if (isAbsolute(inside) || inside.startsWith('..')) throw new Error('Tarball path escapes dist')
    return { plugin, location: options.mode === 'link' ? plugin.dir : archive }
  })
  if (options.mode === 'tarball') {
    const missing = plan.filter(item => !existsSync(item.location))
    if (missing.length) throw new Error(`missing tarball(s): ${missing.map(item => item.plugin.packageName).join(', ')}; run pack first`)
  }
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
  }
  const scratch = join(context.root, '.tmp/install')
  mkdirSync(scratch, { recursive: true })
  const runDir = mkdtempSync(join(scratch, 'run-'))
  try {
    writePnpmShim(runDir, pnpm)
    const env = { ...commandEnv(context), ...runner.env }
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
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
  console.log(`installed ${selected.length} plugin(s); restart DSH if loaded Host code changed`)
  return 0
}
