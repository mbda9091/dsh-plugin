import { parseArgs } from 'node:util'
import { errorMessage } from './core/json.js'
import { loadCommandContext } from './core/command-context.js'
import { runBuild } from './commands/build.js'
import { runCatalog } from './commands/catalog.js'
import { runCheckTargets } from './commands/check-targets.js'
import { runL4 } from './commands/l4.js'
import { runApprovalHostProbe } from './commands/approval-host-probe.js'
import { runL5 } from './commands/l5.js'
import { runStatus } from './commands/status.js'
import { runTest } from './commands/test.js'
import { runCi } from './commands/ci.js'
import { runConfig } from './commands/config.js'
import { runTestEnv } from './commands/test-env.js'
import { runWeb } from './commands/web.js'
import { runDailyWeb } from './commands/daily-web.js'
import { runDailyLauncher } from './commands/daily-launcher.js'
import { runPack } from './commands/pack.js'
import { runInstall } from './commands/install.js'
import { runTarget } from './commands/target.js'
import { runVerifyArtifacts } from './commands/verify-artifacts.js'
import { artifactLock, loadArtifacts } from './core/artifacts.js'

const TOOL_OPTIONS = { 'pnpm-script': { type: 'string' } } as const
const TEST_OPTIONS = {
  ...TOOL_OPTIONS, 'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' }, timeout: { type: 'string' },
} as const
const TARGET_OPTIONS = { target: { type: 'string' }, 'dsh-cli': { type: 'string' }, home: { type: 'string' }, profile: { type: 'string' }, surface: { type: 'string' }, platform: { type: 'string' } } as const

const USAGE = `Usage: node scripts/bootstrap.mjs [command] [options]

Default command: web (also when only startup options are supplied).

  config init [--dry-run] | check | migrate [--dry-run]   Manage v2 disk configuration
  test-env --suite fast|real|all [--only ID,ID] [--keep] [--pnpm-script PATH]  CFG/TOOL/DEV/ISO/ART/TGT tests (per-case deadlines; no --timeout)
  web [--target NAME] [--port PORT] [--open|--no-open] Foreground DSH (macos-web, 3080, no-open)
  daily-launcher prepare|deploy --target NAME --destination PATH [--dry-run] Independent Windows launcher
  dev-web [init|start|status|stop|reset] Managed development Web (random port); reset previews
  build [--check]                     Build/type-check plugins
  pack [--skip-build]                 Build immutable batch; --skip-build requires matching source/output record
  verify-artifacts --manifest PATH [--check] [--keep]   Verify fixed tarballs; durable Web evidence
  dev-install [--skip-build]          Initialize development profile, build/install/verify links
  target discover|list|show NAME|bind NAME|unbind NAME   Manage explicit formal targets
  stable-install --manifest PATH [--only @local/name,...] [--archive-root PATH] Install verified compatible tarballs
    [--profile <name>] [--surface desktop|web] [--platform windows|mac] [--dry-run]
  status --target <name>             Read an explicitly selected target
  test [--only l1,l2,l3] [--skip-build] Run L1-L3
  l4 [--keep] [--home <new .tmp dir>] [--skip-tarball | --manifest PATH]
  l5 [--keep] [--manifest PATH]        Run the isolated Web/browser harness
  approval-host-probe [--manifest PATH] [--keep] Real Web/macOS approvals; optional fixed artifact (no LLM)
  ci [--keep]                         Run environment all, type-check, L1-L3, L4 and L5 (fail-fast)
  check-targets                       Validate plugin metadata (no local config needed)
  catalog [--check] [--output <path>]  Generate/check CATALOG.md (no local config needed)

Tools: --pnpm-script <pnpm.cjs>
Target only: --target NAME or --dsh-cli PATH --home DIR --profile NAME --surface desktop|web --platform windows|mac
Development/test never accept --dsh-cli or inherit daily DSH destination variables.
Tests/CI: --test-browser chrome|chromium, --test-browser-path <path>, --timeout <ms>
Config init accepts --browser edge|default, --browser-path <path>, --test-timeout <ms>.
Runtime commands read local.json, then supported environment variables, then flags.
L4/L5 always create disposable profiles and never load the personal Web patch.`

export async function main(argv: string[]): Promise<number> {
  const defaultWeb = argv[0] === undefined || (argv[0].startsWith('-') && !['--help', '-h'].includes(argv[0]))
  const command = defaultWeb ? 'web' : argv[0]!
  const rest = defaultWeb ? argv : argv.slice(1)
  if (['help', '--help', '-h'].includes(command) || (!['web', 'dev-web'].includes(command) && rest.includes('--help'))) {
    console.log(USAGE)
    return 0
  }
  try {
    switch (command) {
      case 'target': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
          'dsh-cli': TARGET_OPTIONS['dsh-cli'], home: TARGET_OPTIONS.home, profile: TARGET_OPTIONS.profile,
          surface: TARGET_OPTIONS.surface, platform: TARGET_OPTIONS.platform, 'dry-run': { type: 'boolean', default: false },
        } })
        if (positionals.length > 2) throw new Error('unexpected target arguments')
        return runTarget(positionals[0] ?? '', positionals[1], { dshCli: values['dsh-cli'], home: values.home,
          profile: values.profile, surface: values.surface, platform: values.platform, dryRun: values['dry-run'] })
      }
      case 'test-env': {
        // Environment cases own their individual deadlines; there is no suite timeout override.
        const { timeout: _timeout, ...environmentOptions } = TEST_OPTIONS
        const { values } = parseArgs({ args: rest, options: { ...environmentOptions, suite: { type: 'string', default: 'fast' }, only: { type: 'string' }, keep: { type: 'boolean', default: false } } })
        return await runTestEnv(values.suite, values.keep, values['pnpm-script'], values.only, undefined, { browser: values['test-browser'], browserPath: values['test-browser-path'] })
      }
      case 'config': {
        const { values } = parseArgs({ args: rest.slice(1), options: {
          ...TOOL_OPTIONS, 'dry-run': { type: 'boolean', default: false },
          browser: { type: 'string' }, 'browser-path': { type: 'string' },
          'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' }, 'test-timeout': { type: 'string' },
        } })
        return runConfig(rest[0] ?? '', {
          dryRun: values['dry-run'], pnpmScript: values['pnpm-script'],
          browser: values.browser, browserPath: values['browser-path'],
          testBrowser: values['test-browser'], testBrowserPath: values['test-browser-path'],
          testTimeoutMs: parseTimeout(values['test-timeout']),
        })
      }
      case 'web': return await runDailyWeb(rest)
      case 'daily-launcher': return await runDailyLauncher(rest)
      case 'dev-web': return await runWeb(rest)
      case 'build': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, check: { type: 'boolean', default: false } } })
        return await runBuild({ check: values.check }, settings(values))
      }
      case 'pack': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, 'skip-build': { type: 'boolean', default: false } } })
        return await runPack({ skipBuild: values['skip-build'] }, settings(values))
      }
      case 'verify-artifacts': {
        const { values } = parseArgs({ args: rest, options: { ...TEST_OPTIONS, manifest: { type: 'string' }, check: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } } })
        if (!values.manifest) throw new Error('--manifest is required')
        return await runVerifyArtifacts({ manifest: values.manifest, check: values.check, keep: values.keep }, settings(values, 'test'))
      }
      case 'dev-install':
      case 'stable-install': {
        const { values } = parseArgs({ args: rest, options: {
          ...TOOL_OPTIONS, ...TARGET_OPTIONS, 'dry-run': { type: 'boolean', default: false },
          'skip-build': { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
          manifest: { type: 'string' }, only: { type: 'string' }, 'archive-root': { type: 'string' },
        } })
        return await runInstall({
          mode: command === 'dev-install' ? 'link' : 'tarball', profile: values.profile,
          surface: values.surface, platform: values.platform, all: values.all,
          skipBuild: values['skip-build'], dryRun: values['dry-run'],
          manifest: values.manifest,
          only: values.only,
          archiveRoot: values['archive-root'],
        }, settings(values, command === 'dev-install' ? 'development' : 'target'))
      }
      case 'status': {
        const { values } = parseArgs({ args: rest, options: { ...TOOL_OPTIONS, ...TARGET_OPTIONS, manifest: { type: 'string' } } })
        return runStatus({ profile: values.profile, surface: values.surface, platform: values.platform, manifest: values.manifest }, settings(values, 'target'))
      }
      case 'test': {
        const { values } = parseArgs({ args: rest, options: {
          ...TOOL_OPTIONS, only: { type: 'string' }, 'skip-build': { type: 'boolean', default: false },
        } })
        return await runTest({ kinds: values.only === undefined ? [] : [values.only], build: !values['skip-build'] }, settings(values))
      }
      case 'approval-host-probe': {
        const { values } = parseArgs({ args: rest, options: { ...TEST_OPTIONS, keep: { type: 'boolean', default: false }, manifest: { type: 'string' } } })
        const context = settings(values, 'test')
        return await runApprovalHostProbe({ keep: values.keep, timeoutMs: context.config.test.timeoutMs, manifest: values.manifest }, context)
      }
      case 'ci':
      case 'l4':
      case 'l5': {
        const { values } = parseArgs({ args: rest, options: {
          ...TEST_OPTIONS, keep: { type: 'boolean', default: false },
          ...(command !== 'ci' ? { manifest: { type: 'string' as const } } : {}),
          ...(command === 'l4' ? { home: { type: 'string' as const }, 'skip-tarball': { type: 'boolean' as const, default: false } } : {}),
        } })
        const context = settings({ ...values, home: undefined }, 'test')
        const options = { keep: values.keep, timeoutMs: context.config.test.timeoutMs }
        if (command === 'ci') return await runCi(options, context)
        const release = values.manifest ? artifactLock(context.root) : () => {}
        try {
          const artifacts = typeof values.manifest === 'string' ? loadArtifacts(context.root, values.manifest) : undefined
          if (command === 'l5') return await runL5({ ...options, ...(artifacts ? { artifacts } : {}) }, context)
          return await runL4({ ...options, ...(artifacts ? { artifacts } : {}), home: typeof values.home === 'string' ? values.home : undefined, skipTarball: values['skip-tarball'] === true }, context)
        } finally { release() }
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

function settings(values: { target?: string; home?: string; profile?: string; surface?: string; platform?: string; 'dsh-cli'?: string; 'pnpm-script'?: string; 'test-browser'?: string; 'test-browser-path'?: string; timeout?: string }, purpose: 'tools' | 'development' | 'test' | 'target' = 'tools') {
  return loadCommandContext({
    target: values.target, home: values.home, profile: values.profile, surface: values.surface, platform: values.platform, dshCli: values['dsh-cli'], pnpmScript: values['pnpm-script'],
    testBrowser: values['test-browser'], testBrowserPath: values['test-browser-path'], testTimeoutMs: parseTimeout(values.timeout),
  }, undefined, undefined, purpose)
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new Error('timeout must be a positive integer no greater than 2147483647 ms')
  return parsed
}
