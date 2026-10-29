import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checkTestBrowser, commandEnv, configuredDsh, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { assertBrowserResults } from '../core/browser-results.js'
import { runToFiles } from '../core/exec.js'
import { writeText } from '../core/json.js'
import { repoRoot } from '../core/repo.js'
import { childEnv, ensurePnpmShim, initProfile, redactLaunchTokens, runDsh, serveAndCheck } from '../core/web-harness.js'
import type { WebHarness } from '../core/web-harness.js'
import { runBuild } from './build.js'

export interface L5Options {
  readonly keep: boolean
  readonly timeoutMs?: number
}

/** Own both server and browser; never use an ambient GUI URL/profile. */
export async function runL5(input: L5Options, settings: CommandContext = loadCommandContext()): Promise<number> {
  const options = { ...input, timeoutMs: input.timeoutMs ?? settings.config.test.timeoutMs }
  const base = join(repoRoot, '.tmp/l5')
  mkdirSync(base, { recursive: true })
  const runDir = mkdtempSync(join(base, 'run-'))
  const steps: Array<{ name: string; ok: boolean; detail: string }> = []
  let ok = false
  let phase = 'build'
  let context: WebHarness | undefined
  console.log(`l5: run -> ${runDir}`)
  const browser = async (context: WebHarness, mode: 'baseline' | 'fixture'): Promise<void> => {
    phase = mode
    const detail = await serveAndCheck(context, mode, async (url, stderr) => {
      if (/did not activate|@local\//.test(stderr)) throw new Error(`unexpected loader warnings: ${stderr}`)
      const result = runToFiles(process.execPath, [join(repoRoot, 'test/.build/e2e/web-l5.js')], {
        cwd: repoRoot,
        env: {
          ...childEnv(context, context.home), DSH_E2E_URL: url, DSH_E2E_MODE: mode,
          DSH_E2E_ARTIFACTS: join(runDir, 'artifacts', mode),
          DSH_E2E_WORKSPACE: join(runDir, 'workspace'),
          DSH_E2E_TIMEOUT_MS: String(options.timeoutMs),
        },
        timeoutMs: Math.min(options.timeoutMs + 30_000, 2_147_483_647),
        stdoutPath: join(context.logDir, `${mode}.browser.out.log`),
        stderrPath: join(context.logDir, `${mode}.browser.err.log`),
      })
      if (result.status !== 0 || result.timedOut) throw new Error(`browser checks failed (${result.status}, timedOut=${result.timedOut}):\n${result.stdout}\n${result.stderr}`)
      assertBrowserResults(join(runDir, 'artifacts', mode), mode)
      return result.stdout.trim()
    })
    steps.push({ name: mode, ok: true, detail })
    console.log(`l5: PASS ${mode}`)
  }
  try {
    const build = await runBuild({ check: false }, settings)
    if (build !== 0) throw new Error(`build exited with ${build}`)
    phase = 'compile-browser'
    const compiled = spawnSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'test/e2e/tsconfig.json')], { stdio: 'inherit', env: commandEnv(settings) })
    if (compiled.error) throw compiled.error
    if (compiled.status !== 0) throw new Error(`browser compilation exited with ${compiled.status}`)
    phase = 'prerequisites'
    checkTestBrowser(settings)
    context = {
      runner: configuredDsh(settings, true), runDir, home: join(runDir, 'dsh-home'),
      logDir: join(runDir, 'logs'), options, settings,
    }
    mkdirSync(join(runDir, 'workspace'), { recursive: true })
    ensurePnpmShim(context)
    phase = 'profile-init'
    await initProfile(context, phase, context.home)
    await browser(context, 'baseline')
    phase = 'install-fixture'
    for (const [name, target] of [['web-hello', 'test/fixtures/web-hello'], ['notify-web', 'notify-web']] as const) {
      runDsh(context, `install-${name}`, ['plugin', '--profile', 'web', 'add', join(repoRoot, target)], context.home, context.options.timeoutMs)
    }
    await browser(context, 'fixture')
    phase = 'cleanup'
    if (!options.keep) {
      // Cleanup is part of success, so report a failure if it cannot finish.
      for (const name of ['dsh-home', 'pnpm-store', 'bin']) rmSync(join(runDir, name), { recursive: true, force: true })
    }
    ok = true
  } catch (error) {
    const detail = redactLaunchTokens(error instanceof Error ? error.stack ?? error.message : String(error))
    steps.push({ name: phase, ok: false, detail })
    console.error(`l5: FAIL ${phase}\n${detail}`)
  } finally {
    const report = { ok, runDir, dsh: context?.runner.source, steps }
    writeText(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeText(join(base, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`l5: report/artifacts -> ${runDir}`)
  }
  return ok ? 0 : 1
}
