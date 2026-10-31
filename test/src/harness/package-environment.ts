import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Explicit npm/pnpm sources, while preserving OS identity for Chrome/keychain.
 * No HOME/USERPROFILE rewrite: these are not package-manager config selectors.
 */
export function packageEnvironment(parent: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const key of Object.keys(env)) {
    if (/^(npm_config_|pnpm_|corepack_)/i.test(key) || /^(XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_STATE_HOME)$/i.test(key)) delete env[key]
  }
  return Object.assign(env, {
    npm_config_userconfig: join(directory, 'npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_cache: join(directory, 'cache'), npm_config_store_dir: join(directory, 'pnpm-store'),
    pnpm_config_store_dir: join(directory, 'pnpm-store'), PNPM_HOME: join(directory, 'pnpm-home'),
    XDG_STATE_HOME: join(directory, 'state'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'),
  })
}

export function preparePackageEnvironment(directory: string): void {
  for (const name of ['config', 'cache', 'data', 'pnpm-home']) mkdirSync(join(directory, name), { recursive: true })
  for (const name of ['npmrc', 'global.npmrc']) if (!existsSync(join(directory, name))) writeFileSync(join(directory, name), '', { flag: 'wx' })
}
