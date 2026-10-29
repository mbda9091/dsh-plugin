import { parseArgs } from 'node:util'
import { errorMessage } from './core/json.js'
import { loadCommandContext } from './core/command-context.js'
import { runBuild } from './commands/build.js'
import { runCatalog } from './commands/catalog.js'
import { runCheckTargets } from './commands/check-targets.js'
import { runL4 } from './commands/l4.js'
import { runL5 } from './commands/l5.js'
import { runStatus } from './commands/status.js'
import { runTest } from './commands/test.js'
import { runCi } from './commands/ci.js'
import { runConfig } from './commands/config.js'
import { runWeb } from './commands/web.js'
import { runPack } from './commands/pack.js'
import { runInstall } from './commands/install.js'

const TOOL_OPTIONS = { 'dsh-cli': { type: 'string' }, 'pnpm-script': { type: 'string' } } as const
const TEST_OPTIONS = {
  ...TOOL_OPTIONS, 'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' }, timeout: { type: 'string' },
} as const
const TARGET_OPTIONS = { profile: { type: 'string' }, surface: { type: 'string' }, platform: { type: 'string' } } as const

const USAGE = `Usage: node scripts/bootstrap.mjs <command> [options]

  config init [--dry-run] | check      Initialize/check machine-local configuration
  web [--help] [DSH web options]       Start Web using the local JSON and patch
  build [--check]                     Build/type-check plugins
  pack [--skip-build]                 Build and package plugins into dist/
  dev-install [--skip-build]          Build and install compatible directory links
  stable-install                     Install compatible tarballs from dist/
    [--profile <name>] [--surface desktop|web] [--platform windows|mac] [--all] [--dry-run]
  status [--profile <name>] [--surface desktop|web] [--platform windows|mac]
  test [--only l1,l2,l3] [--skip-build] Run L1-L3
  l4 [--keep] [--home <new .tmp dir>] [--skip-tarball]
  l5 [--keep]                         Run the isolated Web/browser harness
  ci [--keep]                         Run type-check, L1-L3, L4 and L5 (fail-fast)
  check-targets                       Validate plugin metadata (no local config needed)
  catalog [--check] [--output <path>]  Generate/check CATALOG.md (no local config needed)

Tools: --dsh-cli <path>, --pnpm-script <pnpm.cjs>
Tests/CI: --test-browser chrome|chromium, --test-browser-path <path>, --timeout <ms>
Config init/check also accepts --browser edge|default, --browser-path <path>, --test-timeout <ms>.
Runtime commands read local.json, then supported environment variables, then flags.
L4/L5 always create disposable profiles and never load the personal Web patch.`

export async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)
  if (command === undefined) { console.error(USAGE); return 1 }
  if (['help', '--help', '-h'].includes(command) || (command !== 'web' && rest.includes('--help'))) {
    console.log(USAGE)
    return 0
  }
  try {
    switch (command) {
      case 'config': {
        const { values } = parseArgs({ args: rest.slice(1), options: {
          ...TOOL_OPTIONS, 'dry-run': { type: 'boolean', default: false },
          browser: { type: 'string' }, 'browser-path': { type: 'string' },
          'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' }, 'test-timeout': { type: 'string' },
        } })
        return runConfig(rest[0] ?? '', {
          dryRun: values['dry-run'], dshCli: values['dsh-cli'], pnpmScript: values['pnpm-script'],
          browser: values.browser, browserPath: values['browser-path'],
          testBrowser: values['test-browser'], testBrowserPath: values['test-browser-path'],
          testTimeoutMs: parseTimeout(values['test-timeout']),
        })
      }
      case 'web': return await runWeb(rest)
      case 'build': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, check: { type: 'boolean', default: false } } })
        return await runBuild({ check: values.check }, settings(values))
      }
      case 'pack': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, 'skip-build': { type: 'boolean', default: false } } })
        return await runPack({ skipBuild: values['skip-build'] }, settings(values))
      }
      case 'dev-install':
      case 'stable-install': {
        const { values } = parseArgs({ args: rest, options: {
          ...TOOL_OPTIONS, ...TARGET_OPTIONS, 'dry-run': { type: 'boolean', default: false },
          'skip-build': { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
        } })
        return await runInstall({
          mode: command === 'dev-install' ? 'link' : 'tarball', profile: values.profile,
          surface: values.surface, platform: values.platform, all: values.all,
          skipBuild: values['skip-build'], dryRun: values['dry-run'],
        }, settings(values))
      }
      case 'status': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, ...TARGET_OPTIONS } })
        return runStatus({ profile: values.profile, surface: values.surface, platform: values.platform }, settings(values))
      }
      case 'test': {
        const { values } = parseArgs({ args: rest, options: {
          ...TOOL_OPTIONS, only: { type: 'string' }, 'skip-build': { type: 'boolean', default: false },
        } })
        return await runTest({ kinds: values.only === undefined ? [] : [values.only], build: !values['skip-build'] }, settings(values))
      }
      case 'ci':
      case 'l4':
      case 'l5': {
        const { values } = parseArgs({ args: rest, options: {
          ...TEST_OPTIONS, keep: { type: 'boolean', default: false },
          ...(command === 'l4' ? { home: { type: 'string' as const }, 'skip-tarball': { type: 'boolean' as const, default: false } } : {}),
        } })
        const context = settings(values)
        const options = { keep: values.keep, timeoutMs: context.config.test.timeoutMs }
        if (command === 'ci') return await runCi(options, context)
        if (command === 'l5') return await runL5(options, context)
        return await runL4({ ...options, home: typeof values.home === 'string' ? values.home : undefined, skipTarball: values['skip-tarball'] === true }, context)
      }
      case 'check-targets': parseArgs({ args: rest, options: {} }); return runCheckTargets()
      case 'catalog': {
        const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean', default: false }, output: { type: 'string' } } })
        return runCatalog({ check: values.check, output: values.output })
      }
      default: console.error(`unknown command: ${command}\n${USAGE}`); return 1
    }
  } catch (error) { console.error(`error: ${errorMessage(error)}`); return 1 }
}

function settings(values: { 'dsh-cli'?: string; 'pnpm-script'?: string; 'test-browser'?: string; 'test-browser-path'?: string; timeout?: string }) {
  return loadCommandContext({
    dshCli: values['dsh-cli'], pnpmScript: values['pnpm-script'],
    testBrowser: values['test-browser'], testBrowserPath: values['test-browser-path'], testTimeoutMs: parseTimeout(values.timeout),
  })
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new Error('timeout must be a positive integer no greater than 2147483647 ms')
  return parsed
}
