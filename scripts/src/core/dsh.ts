import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord, readJson } from './json.js'
import { envValue } from './config.js'

/** $env:DSH_PROFILE, falling back to the desktop profile. */
export function profileName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envValue(env, 'DSH_PROFILE')
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'desktop'
}

/**
 * $env:DSH_PROFILE_DIR only describes the profile this session belongs to, so
 * it must not be reused for a different --profile argument.
 */
export function profileDir(profile: string = profileName(), env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'DSH_PROFILE_DIR')
  if (explicit !== undefined && explicit !== '' && profile === profileName(env)) return explicit

  const home = envValue(env, 'DSH_HOME')
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'profiles', profile)
}

export function readProfileManifest(profile: string = profileName(), env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const path = join(profileDir(profile, env), 'package.json')
  if (!existsSync(path)) throw new Error(`profile manifest not found: ${path}`)

  const manifest = readJson(path)
  if (!isRecord(manifest)) throw new Error(`profile manifest is not an object: ${path}`)
  return manifest
}

/**
 * Describe how a dependency is installed.
 *
 * The manifest alone can lie: switching link -> tarball with pnpm can leave a
 * junction in node_modules while the spec already says `file:`. Report what is
 * actually installed, so an inconsistent state is visible instead of hidden.
 */
export function resolveInstallMode(spec: string | null, linked: boolean): string {
  const lower = spec === null ? '' : spec.toLowerCase()

  let mode: string
  if (spec === null) mode = 'not installed'
  else if (lower.startsWith('link:')) mode = 'link (dev)'
  else if (lower.startsWith('file:') || lower.endsWith('.tgz')) mode = 'tarball (stable)'
  else mode = `package (${spec})`

  if ((lower.startsWith('file:') || lower.endsWith('.tgz')) && linked) mode = 'tarball spec, but LINKED'
  else if (lower.startsWith('link:') && !linked) mode = 'link spec, but COPY'

  return mode
}
