import { parseArgs } from 'node:util'
import { errorMessage } from './core/json.js'
import { configuredPnpm, loadCommandContext } from './core/command-context.js'
import { runBuild } from './commands/build.js'
import { runCatalog } from './commands/catalog.js'
import { runCheckTargets } from './commands/check-targets.js'
import { runL4 } from './commands/l4.js'
import { runL5 } from './commands/l5.js'
import { runTest } from './commands/test.js'
import { runCi } from './commands/ci.js'
import { runTestEnv } from './commands/test-env.js'
import { runWeb } from './commands/web.js'
import { runPack } from './commands/pack.js'
import { runInstall } from './commands/install.js'
import { runVerifyArtifacts } from './commands/verify-artifacts.js'
import { artifactLock, loadArtifacts } from './core/artifacts.js'

const TOOL_OPTIONS = { 'pnpm-script': { type: 'string' } } as const
const TEST_OPTIONS = {
  ...TOOL_OPTIONS, 'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' }, timeout: { type: 'string' },
} as const
const USAGE = `Usage: node scripts/dev.mjs <command> [options]
Development/testing only; no local.json or external installation target.
Commands: build [--check], test, ci, l4, l5, test-env, dev-web,
          dev-install, pack, verify-artifacts, check-targets, catalog.
Tools: pnpm is discovered automatically (npm/Corepack); --pnpm-script or DSH_PNPM optionally overrides it.
Tests: --test-browser chrome|chromium, --test-browser-path PATH, --timeout MS.
External installation: node scripts/install.mjs install --profile NAME.`

export async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'help'
  const rest = argv.slice(1)
  if (['help', '--help', '-h'].includes(command) || (!['web', 'dev-web'].includes(command) && rest.includes('--help'))) {
    console.log(USAGE)
    return 0
  }
  try {
    switch (command) {
      case 'web':
      case 'daily-launcher': throw new Error('daily launch entry removed; manage daily DSH yourself; use dev-web for development')
      case 'test-env': {
        // Environment cases own their individual deadlines; there is no suite timeout override.
        const { timeout: _timeout, ...environmentOptions } = TEST_OPTIONS
        const { values } = parseArgs({ args: rest, options: { ...environmentOptions, suite: { type: 'string', default: 'fast' }, only: { type: 'string' }, keep: { type: 'boolean', default: false } } })
        const pnpm = values.suite === 'fast' ? values['pnpm-script'] : configuredPnpm(settings(values, 'test'))
        return await runTestEnv(values.suite, values.keep, pnpm, values.only, undefined, { browser: values['test-browser'], browserPath: values['test-browser-path'] })
      }
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
      case 'dev-install': {
        const { values } = parseArgs({ args: rest, options: {
          ...TOOL_OPTIONS, 'dry-run': { type: 'boolean', default: false },
          'skip-build': { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
        } })
        return await runInstall({
          mode: 'link', all: values.all,
          skipBuild: values['skip-build'], dryRun: values['dry-run'],
        }, settings(values, 'development'))
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

function settings(values: { target?: string; home?: string; profile?: string; surface?: string; platform?: string; 'dsh-cli'?: string; 'pnpm-script'?: string; 'test-browser'?: string; 'test-browser-path'?: string; timeout?: string }, purpose: 'tools' | 'development' | 'test' = 'tools') {
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
