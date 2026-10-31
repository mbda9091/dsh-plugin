import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { profileDir, readProfileManifest, resolveInstallMode } from '../core/dsh.js'
import { isRecord, stringArray } from '../core/json.js'
import { discoverPlugins } from '../core/plugins.js'
import { formatPluginTarget, isTargetCompatible, resolveTarget } from '../core/targets.js'
import { loadCommandContext, operationTarget } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { validateDevelopmentPaths } from '../core/development.js'
import { inspectTarget } from '../core/formal-target.js'
import { loadArtifacts } from '../core/artifacts.js'
import { checkInstalledPackage } from '../core/artifact-package.js'

export interface StatusOptions {
  readonly profile?: string | undefined
  readonly surface?: string | undefined
  readonly platform?: string | undefined
  readonly manifest?: string | undefined
}

/**
 * Shows how every plugin in this repo is installed in the profile. Reads the
 * profile's package.json only: no writes, no approval.
 */
export function runStatus(options: StatusOptions, context: CommandContext = loadCommandContext()): number {
  validateDevelopmentPaths(context)
  if (context.purpose === 'target') inspectTarget(context)
  const selectedTarget = operationTarget(context)
  const profile = selectedTarget.profile
  const manifest = readProfileManifest(profile, context.env)

  const dsh = manifest['dsh']
  const profileSection = isRecord(dsh) ? dsh['profile'] : undefined
  const bundles = stringArray(isRecord(profileSection) ? profileSection['bundles'] : undefined)
  const dependencies = isRecord(manifest['dependencies']) ? manifest['dependencies'] : {}
  const profileDirectory = profileDir(profile, context.env)

  const target = resolveTarget(selectedTarget)

  console.log(`profile: ${profile}`)
  console.log(`target:  ${target.surface}/${target.platform}`)
  console.log('runtime rows/loading: unconfirmed; capability: unverified (read-only filesystem status)')
  if (options.manifest) {
    const artifacts = loadArtifacts(context.root, options.manifest, false)
    let failed = false
    for (const pkg of artifacts.packages.values()) {
      if (!isTargetCompatible(pkg, target)) { console.log(`${pkg.name}: skip (incompatible)`); continue }
      try { console.log(`${pkg.name}: verified files/bundle ${checkInstalledPackage(pkg, profileDirectory, context.root)}`) }
      catch (error) { failed = true; console.log(`${pkg.name}: ${error instanceof Error ? error.message : 'verification failed'}`) }
    }
    return failed ? 1 : 0
  }

  for (const plugin of discoverPlugins(context.root)) {
    const declared = dependencies[plugin.packageName]
    const spec = typeof declared === 'string' ? declared : null

    // The manifest alone can lie: switching link -> tarball with pnpm can leave
    // a junction in node_modules while the spec already says `file:`. Report
    // what is actually installed.
    const installed = join(profileDirectory, 'node_modules', plugin.packageName)
    const mode = resolveInstallMode(spec, isLinked(installed, profileDirectory, spec))

    const bundle = bundles.includes(plugin.packageName) ? 'bundle=on' : 'bundle=off'
    const compatibility = isTargetCompatible(plugin, target) ? 'compatible' : 'skip'

    console.log(
      `${plugin.packageName.padEnd(28)} ${mode.padEnd(24)} ${bundle.padEnd(14)} ${formatPluginTarget(plugin).padEnd(28)} ${compatibility}`,
    )
  }

  return 0
}

function isLinked(path: string, profile: string, spec: string | null): boolean {
  if (!existsSync(path)) return false
  try {
    // Node reports Windows junctions as symbolic links, which is the same
    // distinction `Get-Item -Force | Select LinkType` exposed.
    if (!lstatSync(path).isSymbolicLink()) return false
    if (spec?.startsWith('link:')) return true
    const rel = relative(join(profile, 'node_modules/.pnpm'), realpathSync(path))
    // pnpm's internal store junction is a regular tarball installation.
    return isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')
  } catch {
    return false
  }
}
