/**
 * L4 fixture: a Host plugin that can never match a running `dsh web`.
 *
 * It declares the reserved `headless` surface, so the guard below always fails
 * in a real Host (the web engine still reports `process.versions.electron`,
 * and even a corrected detector would report `web`). The failure is deliberate:
 * L4 asserts that the loader reports a failed row instead of silently doing
 * nothing.
 *
 * The guard mirrors the packaged plugins' `targets.ts` logic; the fixture is
 * self-contained because plugins may not import from outside their directory.
 */
import { readFileSync } from 'node:fs'

export const name = 'target-mismatch'

function currentPlatform() {
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

export function apply(ctx) {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const targets = manifest.dsh.targets
  const versions = process.versions
  const profile = ctx.get('profileContext')
  const bundles = Array.isArray(profile?.startedBundles)
    ? profile.startedBundles.filter((item) => typeof item === 'string')
    : []
  const isWeb = bundles.some((name) => name === '@deepseek-ai/dsh-web-app' || name.endsWith('/dsh-web-app'))
  const surface = typeof versions.electron === 'string'
    ? 'desktop'
    : isWeb
      ? 'web'
      : 'headless'
  const platform = currentPlatform()
  const context = `declared surfaces=${targets.surfaces.join('+')} platforms=${targets.platforms.join('+')}; current surface=${surface} platform=${platform}`

  if (!targets.surfaces.includes(surface) || !targets.platforms.includes(platform)) {
    throw new Error(`[target-mismatch] target mismatch: ${context}`)
  }
}
