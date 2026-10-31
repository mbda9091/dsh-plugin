import { existsSync, writeFileSync } from 'node:fs'
import { configPaths, loadRepoConfig, readConfigFile, resolveConfig } from '../core/config.js'
import type { ConfigOverrides, ResolvedConfig } from '../core/config.js'
import { discoverBrowser, requireFile, requirePnpm } from '../core/config-tools.js'
import { assertConfigReady, safeConfigPath } from '../core/config-transaction.js'
import { migrateConfig } from '../core/config-migration.js'
import { repoRoot } from '../core/repo.js'

export interface InitResult {
  state: 'existing' | 'preview' | 'created'
  resolved?: ResolvedConfig
  warnings: string[]
}

/** Writes with wx so a concurrent init can never replace a user's file. */
export function initializeConfig(
  options: ConfigOverrides & { dryRun?: boolean }, root: string = repoRoot, env: NodeJS.ProcessEnv = process.env,
): InitResult {
  const paths = configPaths(root)
  const localExists = existsSync(paths.local)
  assertConfigReady(root)
  if (options.dshCli !== undefined) throw new Error('--dsh-cli is not supported by config init; select a complete target explicitly')
  if (localExists) return { state: 'existing', warnings: ['existing file preserved; run config check or config migrate --dry-run'] }

  const resolved = resolveConfig(readConfigFile(paths.example, paths.schema), root, paths.schema, {}, options, 'example.json')
  const { config, sources } = resolved
  const warnings: string[] = []
  if (config.tools.pnpmScript !== null) requirePnpm(config.tools.pnpmScript)
  else warnings.push('pnpm.cjs not configured; use --pnpm-script PATH for commands that need it (tool discovery follows in M2)')

  if (config.web.browserPath !== null) requireFile(config.web.browserPath, 'web.browserPath')
  else if (config.web.browser === 'edge') {
    config.web.browserPath = discoverBrowser('edge', env)
    if (config.web.browserPath !== null) sources['web.browserPath'] = 'browser discovery'
    else {
      config.web.browser = 'default'
      sources['web.browser'] = 'browser discovery'
      warnings.push('Edge not found; selected the system default browser')
    }
  }
  if (config.test.browserPath !== null) requireFile(config.test.browserPath, 'test.browserPath')
  else if (config.test.browser === 'chrome') {
    config.test.browserPath = discoverBrowser('chrome', env)
    if (config.test.browserPath !== null) sources['test.browserPath'] = 'browser discovery'
    else warnings.push('Chrome not found; configure test.browserPath or select chromium before running L5')
  }
  if (options.dryRun) return { state: 'preview', resolved, warnings }

  safeConfigPath(root, paths.local)
  writeFileSync(paths.local, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
  return { state: 'created', resolved, warnings }
}

export function checkConfig(root: string = repoRoot, env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}) {
  if (Object.values(overrides).some(value => value !== undefined)) throw new Error('config check reads disk values only; overrides are not supported')
  const resolved = loadRepoConfig(root, {}, {})
  return { resolved, warnings: [] as string[] }
}

export function runConfig(action: string, options: ConfigOverrides & { dryRun?: boolean }): number {
  if (action === '--help' || action === '-h') {
    console.log('Usage: node scripts/bootstrap.mjs config init [--dry-run] | check | migrate [--dry-run]; init options: [--pnpm-script <path>] [--browser edge|default] [--browser-path <path>] [--test-browser chrome|chromium] [--test-browser-path <path>] [--test-timeout <ms>]')
    return 0
  }
  if (action === 'migrate') {
    if (Object.entries(options).some(([key, value]) => key !== 'dryRun' && value !== undefined)) throw new Error('config migrate accepts only --dry-run')
    console.log(migrateConfig(repoRoot, options.dryRun))
    return 0
  }
  if (action === 'init') {
    const result = initializeConfig(options)
    console.log(`config: ${result.state}`)
    if (result.resolved) printSources(result.resolved)
    for (const warning of result.warnings) console.warn(`config: ${warning}`)
    if (result.state !== 'existing') {
      console.log(`config: ${configPaths().local}`)

    }
    return 0
  }
  if (action === 'check') {
    if (options.dryRun) throw new Error('--dry-run is only supported by config init')
    const { dryRun: _dryRun, ...overrides } = options
    const result = checkConfig(repoRoot, process.env, overrides)
    printSources(result.resolved)
    for (const warning of result.warnings) console.warn(`config: ${warning}`)
    console.log('config: v2 disk structure checked; tools and targets are checked by commands that use them')
    return result.warnings.length === 0 ? 0 : 1
  }
  throw new Error('usage: config init [--dry-run] | config check | config migrate [--dry-run]')
}

function printSources({ config, sources }: ResolvedConfig): void {
  for (const [field, source] of Object.entries(sources)) console.log(`config: ${field} <- ${source}`)
  console.log(`config: ${config.targets.length} explicit target(s); development DSH comes from workspace dependency`)
  console.log(`config: pnpm.cjs = ${config.tools.pnpmScript ?? '(not configured)'}`)
  console.log(`config: browser = ${config.web.browser}; open = ${config.web.openBrowser}; startup timeout = ${config.web.startupTimeoutMs}ms`)
}
