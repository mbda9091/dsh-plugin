import { delimiter, dirname } from 'node:path'
import { loadRepoConfig, envValue } from './config.js'
import type { ConfigOverrides, RepoConfig } from './config.js'
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
}

export function loadCommandContext(
  overrides: ConfigOverrides = {}, root = repoRoot, env: NodeJS.ProcessEnv = process.env,
): CommandContext {
  return { root, config: loadRepoConfig(root, env, overrides).config, env: { ...env } }
}

/** Export only resolved supported values; avoid Windows Path/PATH duplicates. */
export function commandEnv(context: CommandContext): NodeJS.ProcessEnv {
  const env = { ...context.env }
  const managed = ['PATH', 'DSH_CLI', 'DSH_PNPM', 'CHROME_PATH', 'DSH_E2E_BROWSER']
  for (const key of Object.keys(env)) if (managed.includes(key.toUpperCase())) delete env[key]
  env.PATH = [dirname(process.execPath), envValue(context.env, 'PATH')].filter(Boolean).join(delimiter)
  if (context.config.tools.dshCli !== null) env.DSH_CLI = context.config.tools.dshCli
  if (context.config.tools.pnpmScript !== null) env.DSH_PNPM = context.config.tools.pnpmScript
  if (context.config.test.browserPath !== null) env.CHROME_PATH = context.config.test.browserPath
  env.DSH_E2E_BROWSER = context.config.test.browser
  return env
}

export function configuredDsh(context: CommandContext, web: boolean) {
  const path = context.config.tools.dshCli
  if (path === null) throw new Error('tools.dshCli: required for this command; run config init or pass --dsh-cli')
  return web ? webDsh(path, commandEnv(context)) : resolveDsh({ env: { ...commandEnv(context), DSH_CLI: requireFile(path, 'tools.dshCli') } })
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
