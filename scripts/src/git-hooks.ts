import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { runToTemporaryFiles } from './core/exec.js'
import { errorMessage } from './core/json.js'
import { repoRoot } from './core/repo.js'
import { runTestEnvClean } from './commands/test-env-clean.js'

const hookName = 'repo-test-cleanup'
const commandSuffix = ' scripts/git-hooks.mjs pre-push || :'
const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Register only our named native hook; never replace hooksPath or other hooks. */
export function setupGitHooks(root = repoRoot): void {
  root = realpathSync(root)
  if (!existsSync(join(root, '.git'))) throw new Error('Git hook setup requires the repository root with its own Git metadata, not an exported source directory')
  const git = (args: string[], missing = false): string => {
    const result = runToTemporaryFiles(root, 'git', ['-C', root, ...args], { cwd: root, timeoutMs: 30000 })
    if (result.status !== 0 && !(missing && result.status === 1)) throw new Error(`Git hook setup: ${result.stderr.trim() || args.join(' ')}`)
    return result.stdout.trimEnd()
  }
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) throw new Error('Git hook setup requires the repository root, not an exported source directory')
  // An empty hook list exits 1, so probe support with a command-line-only hook.
  git(['-c', 'hook.repo-test-cleanup-probe.command=:', '-c', 'hook.repo-test-cleanup-probe.event=',
    '-c', 'hook.repo-test-cleanup-probe.event=pre-push', '-c', 'hook.repo-test-cleanup-probe.enabled=true',
    '-c', 'hook.pre-push.enabled=true', 'hook', 'list', '-z', 'pre-push'])
  const values = (key: string, local: boolean) => git(['config', ...(local ? ['--local'] : []), '--get-all', key], true)
  for (const field of ['command', 'event', 'enabled']) {
    const key = `hook.${hookName}.${field}`
    if (values(key, false) !== values(key, true)) throw new Error(`Git hook setup: ${key} also exists outside local configuration; review it first`)
  }
  const oldCommand = values(`hook.${hookName}.command`, true)
  if (oldCommand && (!oldCommand.startsWith("'") || !oldCommand.endsWith(commandSuffix) || oldCommand.includes('\n'))) throw new Error('Git hook setup: our hook command was modified; review it first')
  const oldEvent = values(`hook.${hookName}.event`, true)
  if (oldEvent && oldEvent !== 'pre-push') throw new Error('Git hook setup: our hook event was modified; review it first')
  for (const key of [`hook.${hookName}.enabled`, 'hook.pre-push.enabled']) {
    if (git(['config', '--type=bool', '--get', key], true) === 'false') throw new Error(`Git hook setup: ${key} is disabled; review it first`)
  }
  // Git uses a shell for native hook commands. The fallback also covers missing
  // Node/dependencies/compiler failures, which cannot be caught inside the CLI.
  git(['config', '--local', '--replace-all', `hook.${hookName}.command`, quoteShell(process.execPath) + commandSuffix])
  git(['config', '--local', '--replace-all', `hook.${hookName}.enabled`, 'true'])
  git(['config', '--local', '--replace-all', `hook.${hookName}.event`, 'pre-push'])
  if (git(['hook', 'list', '-z', 'pre-push']).split('\0').filter(name => name === hookName).length !== 1) throw new Error('Git hook setup did not activate exactly one cleanup hook')
  console.log('Git pre-push test cleanup enabled; ordinary git push will attempt cleanup before pushing')
}

export async function main(args: string[]): Promise<number> {
  if (args[0] === 'pre-push') {
    try {
      if (await runTestEnvClean(true) !== 0) console.error('pre-push: test cleanup failed; push may continue')
    } catch (error) { console.error(`pre-push: test cleanup failed; push may continue: ${errorMessage(error)}`) }
    return 0
  }
  if (args.length !== 1 || args[0] !== 'setup') { console.error('Usage: node scripts/git-hooks.mjs setup'); return 1 }
  try { setupGitHooks(); return 0 }
  catch (error) { console.error(errorMessage(error)); return 1 }
}
