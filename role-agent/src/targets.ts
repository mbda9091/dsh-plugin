import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** The `dsh.targets` shape this guard reads; build-time validation is stricter. */
export interface Targets {
  surfaces: string[]
  platforms: string[]
}

/** The environment facts the guard compares against. */
export interface Environment {
  surface: string
  platform: string
}

/** The slice of `profileContext` this guard reads. */
interface ProfileContext {
  startedBundles?: unknown
}

/** The bundle that defines the browser surface. */
const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** Read and validate this package's `dsh.targets` from its own manifest. */
function readTargets(): Targets {
  const manifestUrl = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
    dsh?: { targets?: { surfaces?: unknown; platforms?: unknown } }
  }
  const targets = manifest.dsh?.targets
  if (targets === undefined || !Array.isArray(targets.surfaces) || !Array.isArray(targets.platforms)) {
    throw new Error('package.json is missing a valid dsh.targets')
  }
  return {
    surfaces: targets.surfaces.map(String),
    platforms: targets.platforms.map(String),
  }
}

/** Map Node's platform names to the dsh.targets vocabulary. */
function currentPlatform(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'mac'
    case 'linux':
      return 'linux'
    default:
      return process.platform
  }
}

/**
 * Detect the running shape.
 *
 * The Electron desktop engine runs its Host with `ELECTRON_RUN_AS_NODE`, so
 * `process.versions.electron` is the reliable desktop signal. The browser
 * surface is identified by the started bundle list: `dsh web` composes
 * `@deepseek-ai/dsh-web-app`, and that is already available when plugin rows
 * activate. The `webServer` service is not available yet at that point, which
 * is why it must not be used here. A plain Node CLI run has neither and is
 * `headless`.
 */
export function detectEnvironment(ctx: Context): Environment {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string }
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  const bundles = Array.isArray(profile?.startedBundles)
    ? profile.startedBundles.filter((item): item is string => typeof item === 'string')
    : []
  const isWeb = bundles.some((name) => name === WEB_APP_BUNDLE || name.endsWith('/dsh-web-app'))
  return {
    surface: typeof versions.electron === 'string' ? 'desktop' : isWeb ? 'web' : 'headless',
    platform: currentPlatform(),
  }
}

/**
 * Compare declared targets with the running environment.
 *
 * Exported so tests can exercise the web/mac branches without changing the
 * host process. Returns `undefined` when compatible, otherwise the reason.
 */
export function evaluateTarget(targets: Targets, environment: Environment): string | undefined {
  const context = `declared surfaces=${targets.surfaces.join('+')} platforms=${targets.platforms.join('+')}; current surface=${environment.surface} platform=${environment.platform}`
  if (!targets.surfaces.includes(environment.surface)) {
    return `target mismatch: ${context}`
  }
  if (!targets.platforms.includes(environment.platform)) {
    return `target mismatch: ${context}`
  }
  return undefined
}

/**
 * Fail fast when this plugin is loaded outside its declared envelope.
 * Call this before registering any side effects.
 */
export function assertTarget(ctx: Context, pluginName: string): void {
  const problem = evaluateTarget(readTargets(), detectEnvironment(ctx))
  if (problem !== undefined) {
    throw new Error(`[${pluginName}] ${problem}`)
  }
}
