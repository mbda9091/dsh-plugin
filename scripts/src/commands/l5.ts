import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkTestBrowser, commandEnv, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'
import { assertBrowserResults } from '../core/browser-results.js'
import { runToFilesAsync } from '../core/exec.js'
import { repoRoot } from '../core/repo.js'
import { childEnv, ensurePnpmShim, initProfile, runDsh, serveAndCheck } from '../core/web-harness.js'
import { runIsolatedTest } from '../core/test-run.js'
import type { TestReport } from '../core/test-run.js'
import { runBuild } from './build.js'
import type { ArtifactSet } from '../core/artifacts.js'
import { artifactPrerequisites, installArtifacts, checkArtifactInstallations } from '../core/artifact-harness.js'

export interface L5Options { readonly keep: boolean; readonly timeoutMs?: number; readonly artifacts?: ArtifactSet }

/** Own both server and browser; never use an ambient GUI URL/profile. */
export async function runL5(input: L5Options, settings: CommandContext = loadCommandContext({}, undefined, undefined, 'test'), onReport?: (report: TestReport) => void): Promise<number> {
  const options = { ...input, timeoutMs: input.timeoutMs ?? settings.config.test.timeoutMs }
  return runIsolatedTest('l5', settings, options, async context => {
    const { runDir, step } = context
    await step(options.artifacts ? 'package-contracts' : 'build', async () => {
      if (options.artifacts) {
        if (!options.artifacts.packages.has('@local/notify-web')) throw new Error('artifact L5 currently requires notify-web; no generic UI pass is inferred')
        return artifactPrerequisites(context, options.artifacts)
      }
      const code = await runBuild({ check: false }, settings)
      if (code !== 0) throw new Error(`build exited with ${code}`)
      return 'built current source'
    })
    await step('compile-browser', async () => {
      const result = await runToFilesAsync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'test/e2e/tsconfig.json')], {
        env: commandEnv(settings), signal: context.signal, timeoutMs: options.timeoutMs,
        stdoutPath: join(context.logDir, 'compile.out.log'), stderrPath: join(context.logDir, 'compile.err.log'),
      })
      if (result.status !== 0 || result.timedOut) throw new Error(`browser compilation failed: ${result.stdout}\n${result.stderr}`)
      return 'browser tests compiled'
    })
    await step('prerequisites', async () => {
      checkTestBrowser(settings); ensurePnpmShim(context)
      mkdirSync(join(runDir, 'workspace'), { recursive: true })
      return 'browser and pinned pnpm ready'
    })
    await step('profile-init', () => initProfile(context, 'profile-init', context.home))
    const browser = (mode: 'baseline' | 'fixture') => step(mode, () => serveAndCheck(context, mode, async (url, stderr) => {
      if (/did not activate|@local\//.test(stderr)) throw new Error(`unexpected loader warnings: ${stderr}`)
      const result = await runToFilesAsync(process.execPath, [join(repoRoot, 'test/.build/e2e/web-l5.js')], {
        cwd: runDir, signal: context.signal,
        env: { ...childEnv(context, context.home), DSH_E2E_URL: url, DSH_E2E_MODE: mode,
          DSH_E2E_ARTIFACTS: join(runDir, 'artifacts', mode), DSH_E2E_WORKSPACE: join(runDir, 'workspace'),
          DSH_E2E_TIMEOUT_MS: String(options.timeoutMs) },
        timeoutMs: Math.min(options.timeoutMs + 30_000, 2_147_483_647),
        stdoutPath: join(context.logDir, `${mode}.browser.out.log`), stderrPath: join(context.logDir, `${mode}.browser.err.log`),
      })
      if (result.status !== 0 || result.timedOut) throw new Error(`browser checks failed (${result.status}, timedOut=${result.timedOut}):\n${result.stdout}\n${result.stderr}`)
      assertBrowserResults(join(runDir, 'artifacts', mode), mode)
      if (mode === 'fixture' && options.artifacts) checkArtifactInstallations(context, options.artifacts)
      return result.stdout.trim()
    }))
    await browser('baseline')
    await step(options.artifacts ? 'install-artifacts' : 'install-fixture', async () => {
      const evidence = options.artifacts ? await installArtifacts(context, options.artifacts) : ''
      const fixtures: readonly (readonly [string, string])[] = options.artifacts ? [['web-hello', 'test/fixtures/web-hello']] : [['web-hello', 'test/fixtures/web-hello'], ['notify-web', 'notify-web']]
      for (const [name, target] of fixtures) {
        await runDsh(context, `install-${name}`, ['plugin', '--profile', 'web', 'add', join(repoRoot, target)], context.home)
      }
      return evidence || 'fixtures installed'
    })
    await browser('fixture')
  }, onReport)
}
