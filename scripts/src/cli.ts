import { parseArgs } from 'node:util'
import { errorMessage } from './core/json.js'
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

const USAGE = `Usage: node scripts/bootstrap.mjs <command> [options]

Commands:
  config init [--dry-run] | check      Initialize/check machine-local configuration
    [--dsh-cli <path>] [--pnpm-script <path>] [--browser edge|default]
    [--browser-path <path>] [--test-browser chrome|chromium] [--test-browser-path <path>]
  web [--help] [DSH web options]       Start Web using machine-local configuration
  ci [--keep] [--timeout <ms>]          Run type-check, L1-L3, L4 and L5 locally (fail-fast)
  build [--check]                       Build plugins (--check: type-check only)
  check-targets                         Validate dsh.targets, locale prefix, README
  catalog [--check] [--output <path>]   Generate CATALOG.md (--check: verify only)
  status [--profile <name>] [--surface desktop|web] [--platform windows|mac]
  test [--only l1,l2,l3] [--skip-build] Run the compiled L1-L3 node:test suites
  l4 [--keep] [--home <new .tmp dir>] [--skip-tarball] [--timeout <ms>]
                                        Install into a disposable web profile and
                                        assert loader/server behaviour (no browser)
                                        Failures retain logs; --keep also retains successful runs
  l5 [--keep] [--timeout <ms>]          Build and test a disposable Web UI with Playwright

\`build\` runs the metadata gates before invoking tsc. \`test\` rebuilds plugins,
compiles test/src with tsc, then runs node --test. \`l4\` needs the DSH CLI and a
writable workspace-local DSH_HOME; it starts and stops a real \`dsh web\`.`

export async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (command === undefined) {
    console.error(USAGE)
    return 1
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }

  try {
    switch (command) {
      case 'config': {
        const { values } = parseArgs({ args: rest.slice(1), options: {
          'dry-run': { type: 'boolean', default: false },
          'dsh-cli': { type: 'string' }, 'pnpm-script': { type: 'string' },
          browser: { type: 'string' }, 'browser-path': { type: 'string' },
          'test-browser': { type: 'string' }, 'test-browser-path': { type: 'string' },
        } })
        return runConfig(rest[0] ?? '', {
          dryRun: values['dry-run'], dshCli: values['dsh-cli'], pnpmScript: values['pnpm-script'],
          browser: values.browser, browserPath: values['browser-path'],
          testBrowser: values['test-browser'], testBrowserPath: values['test-browser-path'],
        })
      }
      case 'web': return await runWeb(rest)
      case 'ci': {
        const { values } = parseArgs({ args: rest, options: {
          keep: { type: 'boolean', default: false }, timeout: { type: 'string' },
        } })
        return await runCi({ keep: values.keep, timeoutMs: parseTimeout(values.timeout) })
      }
      case 'build': {
        const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean', default: false } } })
        return await runBuild({ check: values.check })
      }
      case 'check-targets': {
        parseArgs({ args: rest, options: {} })
        return runCheckTargets()
      }
      case 'catalog': {
        const { values } = parseArgs({
          args: rest,
          options: { check: { type: 'boolean', default: false }, output: { type: 'string' } },
        })
        return runCatalog({ check: values.check, output: values.output })
      }
      case 'status': {
        const { values } = parseArgs({
          args: rest,
          options: {
            profile: { type: 'string' },
            surface: { type: 'string' },
            platform: { type: 'string' },
          },
        })
        return runStatus({ profile: values.profile, surface: values.surface, platform: values.platform })
      }
      case 'test': {
        const { values } = parseArgs({
          args: rest,
          options: {
            only: { type: 'string' },
            'skip-build': { type: 'boolean', default: false },
          },
        })
        return await runTest({
          kinds: values.only === undefined ? [] : [values.only],
          build: !values['skip-build'],
        })
      }
      case 'l5': {
        const { values } = parseArgs({ args: rest, options: {
          keep: { type: 'boolean', default: false }, timeout: { type: 'string' },
        } })
        return await runL5({ keep: values.keep, timeoutMs: parseTimeout(values.timeout) })
      }
      case 'l4': {
        const { values } = parseArgs({
          args: rest,
          options: {
            keep: { type: 'boolean', default: false },
            home: { type: 'string' },
            'skip-tarball': { type: 'boolean', default: false },
            timeout: { type: 'string' },
          },
        })
        return await runL4({
          keep: values.keep,
          home: values.home,
          skipTarball: values['skip-tarball'],
          timeoutMs: parseTimeout(values.timeout),
        })
      }
      default:
        console.error(`unknown command: ${command}`)
        console.error(USAGE)
        return 1
    }
  } catch (error) {
    console.error(`error: ${errorMessage(error)}`)
    return 1
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === '') return 120_000
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--timeout must be a positive integer (ms), got '${value}'`)
  return parsed
}
