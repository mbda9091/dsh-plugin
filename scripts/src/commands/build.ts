import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { discoverPlugins } from '../core/plugins.js'
import { repoRoot } from '../core/repo.js'
import { runCatalog } from './catalog.js'
import { runCheckTargets } from './check-targets.js'
import { commandEnv, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'

export interface BuildOptions {
  readonly check: boolean
}

/** A plugin's optional esbuild bundle declaration. */
interface BuildSpec {
  readonly host?: { readonly entry: string; readonly format?: 'esm' }
  readonly client?: { readonly entry: string; readonly format?: 'iife' }
}

const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const packagesRoot = join(repoRoot, 'packages')

/**
 * Build the repository's private workspace libraries before the plugins that
 * consume their declarations.
 *
 * @param check - only emit declarations (enough for plugin type checking).
 * @returns process status.
 */
function buildWorkspaceLibraries(check: boolean, env: NodeJS.ProcessEnv): number {
  if (!existsSync(packagesRoot)) return 0
  const libraries = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'tsconfig.json')))
    .sort()

  for (const dir of libraries) {
    console.log(`· packages/${dir.slice(packagesRoot.length + 1)}`)
    const args = [tsc, '-p', join(dir, 'tsconfig.json')]
    if (check) args.push('--emitDeclarationOnly')
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
    if (result.error) throw new Error(`cannot run tsc: ${result.error.message}`)
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

/**
 * Read a plugin's `build.json` bundle declaration.
 *
 * @param dir - plugin directory.
 * @returns the declaration, or `undefined` for a legacy tsc-only plugin.
 */
function readBuildSpec(dir: string): BuildSpec | undefined {
  const path = join(dir, 'build.json')
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as {
    host?: { entry?: unknown; format?: unknown }
    client?: { entry?: unknown; format?: unknown }
  }
  const spec: { host?: { entry: string; format: 'esm' }; client?: { entry: string; format: 'iife' } } = {}
  if (value.host !== undefined) {
    if (typeof value.host.entry !== 'string' || value.host.format !== 'esm') {
      throw new Error(`${path}: host must have an entry and format "esm"`)
    }
    spec.host = { entry: value.host.entry, format: 'esm' }
  }
  if (value.client !== undefined) {
    if (typeof value.client.entry !== 'string' || value.client.format !== 'iife') {
      throw new Error(`${path}: client must have an entry and format "iife"`)
    }
    spec.client = { entry: value.client.entry, format: 'iife' }
  }
  return spec
}

/**
 * Resolve the platform-specific esbuild executable.
 *
 * The JavaScript wrapper (`esbuild/bin/esbuild`) starts a service child process
 * and fails under DSH's sandbox (`spawn EPERM`). The native executable can be
 * spawned with inherited stdio, which the sandbox permits, and it reads/writes
 * the workspace directly.
 *
 * @returns absolute path to the esbuild executable.
 */
function resolveEsbuild(): string {
  const require = createRequire(import.meta.url)
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`
  const packageDir = dirname(require.resolve(`${platformPackage}/package.json`))
  return process.platform === 'win32'
    ? join(packageDir, 'esbuild.exe')
    : join(packageDir, 'bin', 'esbuild')
}

/**
 * Bundle one plugin's host/client entries with esbuild.
 *
 * @param dir - plugin directory.
 * @param spec - bundle declaration.
 * @returns process status.
 */
async function bundlePlugin(dir: string, spec: BuildSpec, env: NodeJS.ProcessEnv): Promise<number> {
  const targets: Array<{ entry: string; format: 'esm' | 'iife'; outfile: string; platform: 'node' | 'browser' }> = []
  if (spec.host !== undefined) {
    targets.push({ entry: spec.host.entry, format: 'esm', outfile: 'lib/index.js', platform: 'node' })
  }
  if (spec.client !== undefined) {
    targets.push({ entry: spec.client.entry, format: 'iife', outfile: 'lib/client.js', platform: 'browser' })
  }

  const executable = resolveEsbuild()
  for (const target of targets) {
    const result = spawnSync(executable, [
      target.entry,
      '--bundle',
      `--format=${target.format}`,
      `--platform=${target.platform}`,
      '--target=es2022',
      `--outfile=${target.outfile}`,
      '--sourcemap',
      '--log-level=warning',
    ], { cwd: dir, stdio: 'inherit', env })
    if (result.error) throw new Error(`cannot run esbuild: ${result.error.message}`)
    if (result.status !== 0) {
      console.error(`bundle failed for ${dir} → ${target.outfile}`)
      return result.status ?? 1
    }
  }
  return 0
}

/**
 * Builds or type-checks every plugin with the TypeScript compiler. Plugins that
 * declare `build.json` are bundled with esbuild after their declarations are
 * emitted, so shared `@local/notify-core` code is inlined into each runtime
 * artifact and never needs a profile dependency.
 *
 * The metadata gates run first so a bad dsh.targets, a stale locale prefix, or
 * an outdated CATALOG.md fails fast with a path to the fix.
 *
 * @param options - build mode.
 * @returns process status.
 */
export async function runBuild(options: BuildOptions, context: CommandContext = loadCommandContext()): Promise<number> {
  const env = commandEnv(context)
  const targetsCode = runCheckTargets()
  if (targetsCode !== 0) return targetsCode

  const catalogCode = runCatalog({ check: true })
  if (catalogCode !== 0) return catalogCode

  if (!existsSync(tsc)) throw new Error('typescript is not installed. Run `pnpm install` first.')

  const librariesCode = buildWorkspaceLibraries(options.check, env)
  if (librariesCode !== 0) return librariesCode

  // Discovery is manifest-driven: a top-level tsconfig.json alone is not a
  // plugin, otherwise scripts/ itself would be compiled as one.
  const projects = discoverPlugins(repoRoot).filter((plugin) => existsSync(join(plugin.dir, 'tsconfig.json')))
  if (projects.length === 0) throw new Error('No plugin tsconfig.json found.')

  for (const project of projects) {
    console.log(`· ${project.dirName}`)
    const spec = readBuildSpec(project.dir)
    if (spec !== undefined && !options.check) {
      // Bundled plugins may have dropped a previous client entry; stale files
      // in lib/ would otherwise survive into the package.
      rmSync(join(project.dir, 'lib'), { recursive: true, force: true })
    }
    const hostArgs = [tsc, '-p', join(project.dir, 'tsconfig.json')]
    if (options.check) hostArgs.push('--noEmit')
    else if (spec !== undefined) hostArgs.push('--emitDeclarationOnly')

    // Inherited stdio: piped child stdio is denied under DSH's sandbox.
    const hostResult = spawnSync(process.execPath, hostArgs, { stdio: 'inherit', env })
    if (hostResult.error) throw new Error(`cannot run tsc: ${hostResult.error.message}`)
    if (hostResult.status !== 0) return hostResult.status ?? 1

    if (spec !== undefined) {
      const clientProject = join(project.dir, 'tsconfig.client.json')
      if (existsSync(clientProject)) {
        const clientResult = spawnSync(process.execPath, [tsc, '-p', clientProject, '--noEmit'], { stdio: 'inherit', env })
        if (clientResult.error) throw new Error(`cannot run tsc: ${clientResult.error.message}`)
        if (clientResult.status !== 0) return clientResult.status ?? 1
      }
      if (!options.check) {
        const bundleCode = await bundlePlugin(project.dir, spec, env)
        if (bundleCode !== 0) return bundleCode
      }
    }
  }

  return 0
}
