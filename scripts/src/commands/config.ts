import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { configPaths, loadRepoConfig, readConfigFile, resolveConfig } from '../core/config.js'
import type { ConfigOverrides, ResolvedConfig } from '../core/config.js'
import { discoverBrowser, discoverDsh, discoverPnpm, requireFile, requirePnpm, webDsh } from '../core/config-tools.js'
import { renderWebPatch, inspectWebPatch } from '../core/web-patch.js'
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
  const patchExists = existsSync(paths.patch)
  if (localExists && patchExists) return { state: 'existing', warnings: ['existing files preserved; run config check'] }
  if (localExists || patchExists) throw new Error('incomplete local configuration: only one file exists; back up and review both files before init')

  const resolved = resolveConfig(readConfigFile(paths.example, paths.schema), root, paths.schema, env, options, 'example.json')
  const { config, sources } = resolved
  const warnings: string[] = []
  const dsh = discoverDsh(config.tools.dshCli, env)
  if (config.tools.dshCli === null) sources['tools.dshCli'] = dsh.source
  config.tools.dshCli = dsh.path
  const pnpm = discoverPnpm(config.tools.pnpmScript, env)
  if (config.tools.pnpmScript === null && pnpm !== null) sources['tools.pnpmScript'] = 'DSH runtime'
  config.tools.pnpmScript = pnpm
  if (pnpm === null) warnings.push('pnpm.cjs not found; optional for Web startup')

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
    else warnings.push('Chrome not found; test configuration is reserved for phase 2')
  }
  const patch = renderWebPatch(readFileSync(paths.patchExample, 'utf8'), root, paths.patchExample)
  if (options.dryRun) return { state: 'preview', resolved, warnings }

  let written = false
  try {
    writeFileSync(paths.local, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
    written = true
    writeFileSync(paths.patch, patch, { flag: 'wx' })
  } catch {
    throw new Error(`config init write failed; ${written ? 'local.json was created; patch was not written by this run' : 'no files written by this run'}. Review both files; nothing was overwritten`)
  }
  return { state: 'created', resolved, warnings }
}

export function checkConfig(root: string = repoRoot, env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}) {
  const resolved = loadRepoConfig(root, env, overrides)
  const { config } = resolved
  if (config.tools.dshCli === null) throw new Error('tools.dshCli: required for Web; configure a plain-Node CLI')
  webDsh(config.tools.dshCli, env)
  if (config.tools.pnpmScript !== null) requirePnpm(config.tools.pnpmScript)
  if (config.test.browser === 'chrome' && config.test.browserPath !== null) requireFile(config.test.browserPath, 'test.browserPath')
  if (config.web.openBrowser && config.web.browser === 'edge') {
    if (config.web.browserPath === null) throw new Error('web.browserPath: required for Edge; set browser to default to use the system browser')
    requireFile(config.web.browserPath, 'web.browserPath')
  }
  const inspection = inspectWebPatch(configPaths(root).patch, root)
  const warnings = [...inspection.warnings]
  for (const path of inspection.roots) if (!existsSync(path)) warnings.push(`HMR directory is absent; build plugins or review path: ${path}`)
  return { resolved, warnings }
}

export function runConfig(action: string, options: ConfigOverrides & { dryRun?: boolean }): number {
  if (action === '--help' || action === '-h') {
    console.log('Usage: scripts/config.ps1 init [--dry-run] | check [--dsh-cli <path>] [--pnpm-script <path>] [--browser edge|default] [--browser-path <path>] [--test-browser chrome|chromium] [--test-browser-path <path>]')
    return 0
  }
  if (action === 'init') {
    const result = initializeConfig(options)
    console.log(`config: ${result.state}`)
    if (result.resolved) printSources(result.resolved)
    for (const warning of result.warnings) console.warn(`config: ${warning}`)
    if (result.state !== 'existing') {
      console.log(`config: ${configPaths().local}`)
      console.log(`config: ${configPaths().patch}`)
      console.log('config: install @local/notify-web in the web profile before using the default patch')
    }
    return 0
  }
  if (action === 'check') {
    if (options.dryRun) throw new Error('--dry-run is only supported by config init')
    const result = checkConfig(repoRoot, process.env, options)
    printSources(result.resolved)
    for (const warning of result.warnings) console.warn(`config: ${warning}`)
    console.log('config: structure, Web CLI and local patch checked; plugin activation is verified by DSH at startup')
    return result.warnings.length === 0 ? 0 : 1
  }
  throw new Error('usage: config init [--dry-run] | config check')
}

function printSources({ config, sources }: ResolvedConfig): void {
  for (const [field, source] of Object.entries(sources)) console.log(`config: ${field} <- ${source}`)
  console.log(`config: DSH CLI = ${config.tools.dshCli}`)
  console.log(`config: pnpm.cjs = ${config.tools.pnpmScript ?? '(not configured)'}`)
  console.log(`config: browser = ${config.web.browser}; open = ${config.web.openBrowser}; startup timeout = ${config.web.startupTimeoutMs}ms`)
}
