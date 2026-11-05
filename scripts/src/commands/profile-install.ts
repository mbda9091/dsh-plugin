import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import type { CommandContext } from '../core/command-context.js'
import { configuredPnpm } from '../core/command-context.js'
import { inspectTarget } from '../core/formal-target.js'
import { validateDevelopmentPaths } from '../core/development.js'
import { discoverPlugins } from '../core/plugins.js'
import { isTargetCompatible, resolveTarget } from '../core/targets.js'
import { installCache } from '../core/install-cache.js'
import { artifactLock, loadArtifacts } from '../core/artifacts.js'
import { packUnlocked } from './pack.js'
import { runDirectArtifactInstall } from './install-artifacts.js'
import { packageDefaults, planProfilePatch } from '../core/profile-patch.js'
import type { Defaults } from '../core/profile-patch.js'
import { plainPath } from '../core/daily-contract.js'
import { checkInstallHost } from '../core/install-host.js'
import { archiveLocation } from '../core/daily-archive.js'

export interface ProfileInstallOptions { only?: string | undefined; rebuild: boolean; dryRun: boolean; archiveRoot?: string | undefined }
export async function runProfileInstall(options: ProfileInstallOptions, context: CommandContext): Promise<number> {
  validateDevelopmentPaths(context)
  const initial = inspectTarget(context), { directory, target } = initial
  if (target.surface !== 'web') throw new Error('install supports Web only; Windows Desktop is out of scope')
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) throw new Error('install requires an existing profile package.json; prepare the profile yourself')
  const plugins = discoverPlugins(context.root), names = options.only?.split(',')
  if (names && (!names.length || new Set(names).size !== names.length || names.some(n => !plugins.some(p => p.packageName === n)))) throw new Error('--only requires unique known plugin package names')
  const selected = plugins.filter(p => names ? names.includes(p.packageName) : isTargetCompatible(p, resolveTarget(target)))
  if (!selected.length || selected.some(p => !isTargetCompatible(p, resolveTarget(target)))) throw new Error('no compatible plugins or incompatible --only selection')
  await checkInstallHost(context)
  configuredPnpm(context)
  if (options.archiveRoot && !isAbsolute(options.archiveRoot)) throw new Error('--archive-root must be absolute')
  const archiveRoot = resolve(options.archiveRoot ?? join(homedir(), '.local/share/dsh-plugin/releases'))
  archiveLocation(context.root, target.home, archiveRoot)
  const lock = join(directory, '.mbda9091-install.lock'); plainPath(lock)
  if (!options.dryRun) writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  try {
    let path: string | undefined
    const release = artifactLock(context.root)
    try {
      const cache = installCache(context.root, options.rebuild)
      console.log(`${cache.mode}: ${cache.reason}`)
      let defaults: Defaults[]
      if (cache.manifest) {
        const set = loadArtifacts(context.root, cache.manifest)
        defaults = selected.map(p => packageDefaults(set.packages.get(p.packageName)!))
      } else {
        defaults = selected.map(p => packageDefaults({ name: p.packageName, files: new Map([
          ['package.json', readFileSync(join(p.dir, 'package.json'))],
          ['profile.defaults.patch.yml', readFileSync(join(p.dir, 'profile.defaults.patch.yml'))],
        ]) } as Parameters<typeof packageDefaults>[0]))
      }
      const plan = planProfilePatch(directory, defaults)
      console.log(JSON.stringify({ profile: directory, packages: selected.map(p => p.packageName), configuration: plan.path, added: plan.added, preserved: plan.preserved, archiveRoot, dryRun: options.dryRun }))
      if (options.dryRun) return 0
      path = cache.manifest
      if (!path) {
        const code = await packUnlocked({ skipBuild: cache.mode === 'reuse-build' }, context, value => { path = value })
        if (code !== 0) return code
      }
    } finally { release() }
    if (!path) throw new Error('packing produced no manifest')
    if (JSON.stringify(inspectTarget(context).identity) !== JSON.stringify(initial.identity)) throw new Error('target identity changed')
    return await runDirectArtifactInstall({ mode: 'tarball', manifest: path, only: selected.map(p => p.packageName).join(','), archiveRoot, all: false, skipBuild: false, dryRun: false }, context)
  } finally { if (!options.dryRun) unlinkSync(lock) }
}
