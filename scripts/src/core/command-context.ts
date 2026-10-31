import { delimiter, dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { loadRepoConfig, envValue } from './config.js'
import type { ConfigOverrides, RepoConfig, InstallTarget } from './config.js'
import { isRecord } from './json.js'
import { safeConfigPath } from './config-transaction.js'
import { requireFile, requirePnpm, webDsh } from './config-tools.js'
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
  const managed = ['PATH', 'DSH_CLI', 'DSH_PNPM', 'CHROME_PATH', 'DSH_E2E_BROWSER', 'DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'PNPM_CONFIG_STORE_DIR', 'NPM_CONFIG_STORE_DIR', 'ELECTRON_RUN_AS_NODE']
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
    env.pnpm_config_store_dir = join(context.root, '.local/dsh-dev/store')
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
    return web ? webDsh(path, commandEnv(context)) : resolveDsh({ env: { ...commandEnv(context), DSH_CLI: requireFile(path, 'target.dshCli') } })
  }
  // Only a declared workspace package may supply the development entry. No PATH fallback.
  const manifest = join(context.root, 'package.json')
  const pkg = join(context.root, 'node_modules/@deepseek-ai/dsh/package.json')
  if (!existsSync(manifest) || !existsSync(pkg)) throw new Error('workspace development DSH is not prepared; complete M2 (locked dependency); no fallback to legacy CLI')
  const declared: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const installed: unknown = JSON.parse(readFileSync(pkg, 'utf8'))
  if (!isRecord(declared) || !isRecord(declared.devDependencies) || !isRecord(installed) || installed.version !== declared.devDependencies['@deepseek-ai/dsh']) throw new Error('workspace DSH must match the exact declared development dependency (M2)')
  const bin = typeof installed.bin === 'string' ? installed.bin : isRecord(installed.bin) ? installed.bin.dsh : undefined
  if (typeof bin !== 'string') throw new Error('workspace DSH has no public dsh bin entry (M2)')
  const entry = resolve(dirname(pkg), bin)
  requireFile(entry, 'workspace DSH bin')
  return { command: process.execPath, source: entry, env: {}, verbatim: false, build: (args: readonly string[]) => [entry, ...args] }
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
  return requirePnpm(path)
}

export function checkTestBrowser(context: CommandContext): void {
  if (context.config.test.browser === 'chromium') return // Playwright locates its matching downloaded browser.
  const path = context.config.test.browserPath
  if (path === null) throw new Error('test.browserPath: Chrome is not configured; use --test-browser-path or --test-browser chromium')
  requireFile(path, 'test.browserPath')
}
