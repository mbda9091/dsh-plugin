import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { commandEnv } from './command-context.js'
import type { CommandContext } from './command-context.js'
import { inspectTarget } from './formal-target.js'
import { runToFilesAsync } from './exec.js'
import { safeConfigPath } from './config-transaction.js'

/** Direct installation supports only the repository's exact DSH API version. */
export function assertInstallHostVersion(root: string, host: string): void {
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.['@deepseek-ai/dsh']
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expected)) throw new Error('root must declare an exact @deepseek-ai/dsh version')
  if (host !== expected) throw new Error(`incompatible DSH version: target ${host}, required ${expected}; select a matching target DSH before installing`)
}

/** Probe in disposable data, including for previews; never use the target home. */
export async function checkInstallHost(context: CommandContext): Promise<void> {
  const { runner, target } = inspectTarget(context)
  const base = join(context.root, '.tmp/install-host')
  safeConfigPath(context.root, base); mkdirSync(base, { recursive: true })
  const scratch = mkdtempSync(join(base, 'probe-'))
  try {
    const env = { ...commandEnv(context), ...runner.env }
    for (const key of Object.keys(env)) if (/^DSH_/i.test(key)) delete env[key]
    env.DSH_HOME = join(scratch, 'home')
    env.DSH_PROFILE = target.profile
    env.DSH_PROFILE_DIR = join(env.DSH_HOME, 'profiles', target.profile)
    const result = await runToFilesAsync(runner.command, runner.build(['--version']), {
      cwd: scratch, env, verbatim: runner.verbatim, timeoutMs: 30_000,
      stdoutPath: join(scratch, 'version.out'), stderrPath: join(scratch, 'version.err'),
    })
    const host = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(result.stdout.trim())?.[0]
    if (result.status !== 0 || result.timedOut || !host) throw new Error('cannot determine selected target DSH version')
    assertInstallHostVersion(context.root, host)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
