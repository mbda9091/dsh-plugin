import { delimiter, dirname, join, resolve } from 'node:path'
import { loadRepoConfig, envValue } from './config.js'
import type { ConfigOverrides, RepoConfig, InstallTarget } from './config.js'
import { checkNode, checkPnpm, workspaceDsh } from './toolchain.js'
import { safeConfigPath } from './config-transaction.js'
import { assertExternalDsh, requireFile, requirePnpm, webDsh } from './config-tools.js'
import { resolveDsh } from './dsh-cli.js'
import { repoRoot } from './repo.js'

/** One resolved configuration per command, shared with nested commands.
 * This contains tool/test settings, never a personal Web patch or credentials.
 */
export interface CommandContext {
  readonly root: string
  readonly config: RepoConfig
  readonly env: NodeJS.ProcessEnv
  readonly purpose: 'tools' | 'development' | 'test' | 'target'
  readonly target?: InstallTarget
}

export function loadCommandContext(
  overrides: ConfigOverrides = {}, root = repoRoot, env: NodeJS.ProcessEnv = process.env,
  purpose: CommandContext['purpose'] = 'tools',
): CommandContext {
  checkNode()
  const targetKeys = ['dshCli', 'home', 'profile', 'surface', 'platform', 'target'] as const
  if (purpose !== 'target' && targetKeys.some(key => overrides[key] !== undefined)) throw new Error('target flags including --dsh-cli are not supported for this command; development/test use workspace DSH (M2)')
  const configEnv = { ...env }
  if (purpose !== 'test') for (const key of Object.keys(configEnv)) if (['CHROME_PATH', 'DSH_E2E_BROWSER'].includes(key.toUpperCase())) delete configEnv[key]
  const config = loadRepoConfig(root, configEnv, overrides).config
  let target: InstallTarget | undefined
  if (purpose === 'target') {
    if (overrides.target !== undefined) {
      if (targetKeys.some(key => key !== 'target' && overrides[key] !== undefined)) throw new Error('--target cannot be combined with explicit target fields')
      target = config.targets.find(item => item.name === overrides.target)
      if (!target) throw new Error('unknown named target')
    } else {
      if (!overrides.dshCli || !overrides.home || !overrides.profile || !overrides.surface || !overrides.platform) throw new Error('explicit target required: --target NAME or all of --dsh-cli --home --profile --surface --platform; DSH environment variables cannot fill missing fields')
      if ([overrides.dshCli, overrides.home].some(path => !/\S/.test(path) || /[\0\r\n]/.test(path))) throw new Error('invalid explicit target path')
      if (!['desktop', 'web'].includes(overrides.surface) || !['windows', 'mac'].includes(overrides.platform) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(overrides.profile)) throw new Error('invalid explicit target profile/surface/platform')
      target = { name: 'explicit', dshCli: resolve(root, overrides.dshCli), home: resolve(root, overrides.home), profile: overrides.profile, surface: overrides.surface as InstallTarget['surface'], platform: overrides.platform as InstallTarget['platform'] }
    }
  }
  const context: CommandContext = { root, config, env: { ...env }, purpose, ...(target ? { target } : {}) }
  return { ...context, env: commandEnv(context) }
}

/** Export only resolved supported values; avoid Windows Path/PATH duplicates. */
export function commandEnv(context: CommandContext): NodeJS.ProcessEnv {
  const env = { ...context.env }
  const managed = ['PATH', 'DSH_CLI', 'DSH_PNPM', 'CHROME_PATH', 'DSH_E2E_BROWSER', 'DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'ELECTRON_RUN_AS_NODE']
  for (const key of Object.keys(env)) if (managed.includes(key.toUpperCase())) delete env[key]
  env.PATH = [dirname(process.execPath), envValue(context.env, 'PATH')].filter(Boolean).join(delimiter)
  if (context.target) {
    env.DSH_HOME = context.target.home
    env.DSH_PROFILE = context.target.profile
    env.DSH_PROFILE_DIR = join(context.target.home, 'profiles', context.target.profile)
  } else if (context.purpose === 'development') {
    env.DSH_HOME = join(context.root, '.local/dsh-dev/home')
    env.DSH_PROFILE = 'web'
    env.DSH_PROFILE_DIR = join(env.DSH_HOME, 'profiles/web')
  }
  if (context.config.tools.pnpmScript !== null) env.DSH_PNPM = context.config.tools.pnpmScript
  if (context.config.test.browserPath !== null) env.CHROME_PATH = context.config.test.browserPath
  env.DSH_E2E_BROWSER = context.config.test.browser
  return env
}

export function configuredDsh(context: CommandContext, web: boolean) {
  if (context.purpose === 'target') {
    if (!context.target) throw new Error('explicit target required')
    const path = context.target.dshCli
    assertExternalDsh(path, context.root, commandEnv(context))
    return web ? webDsh(path, commandEnv(context)) : resolveDsh({ env: { ...commandEnv(context), DSH_CLI: requireFile(path, 'target.dshCli') } })
  }
  return workspaceDsh(context.root)
}

export function operationTarget(context: CommandContext): InstallTarget {
  if (context.purpose === 'target' && context.target) return context.target
  if (context.purpose !== 'development') throw new Error('installation/status requires a development or explicit target context')
  const home = join(context.root, '.local/dsh-dev/home')
  safeConfigPath(context.root, home)
  return { name: 'development', dshCli: '', home, profile: 'web', surface: 'web', platform: process.platform === 'win32' ? 'windows' : 'mac' }
}

export function configuredPnpm(context: CommandContext): string {
  const path = context.config.tools.pnpmScript
  if (path === null) throw new Error('tools.pnpmScript: required for this command; set it locally or pass --pnpm-script')
  return checkPnpm(requirePnpm(path), context.root)
}

export function checkTestBrowser(context: CommandContext): void {
  if (context.config.test.browser === 'chromium') return // Playwright locates its matching downloaded browser.
  const path = context.config.test.browserPath
  if (path === null) throw new Error('test.browserPath: Chrome is not configured; use --test-browser-path or --test-browser chromium')
  requireFile(path, 'test.browserPath')
}
