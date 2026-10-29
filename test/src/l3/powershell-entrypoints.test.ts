import assert from 'node:assert/strict'
import { it } from 'node:test'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runToFiles } from '../../../scripts/.build/core/exec.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

it('L3 PowerShell wrappers preserve arguments and exit codes, and do not override configured timeout implicitly', { skip: process.platform !== 'win32' }, () => {
  const root = makeTempDir("wrapper-中文-'quote")
  try {
    const scripts = join(root, 'scripts')
    mkdirSync(scripts)
    copyFileSync(join(repoRoot, 'scripts/common.ps1'), join(scripts, 'common.ps1'))
    writeFileSync(join(scripts, 'bootstrap.mjs'), `import fs from 'node:fs'; fs.writeFileSync(process.env.TEST_TRACE, JSON.stringify({args:process.argv.slice(2), cli:process.env.DSH_CLI})); process.exitCode=7;`)
    const cases: Array<[string, string[], string[]]> = [
      ['build', ['-Check'], ['--check']],
      ['pack', ['-SkipBuild'], ['--skip-build']],
      ['dev-install', ['-Profile', 'web', '-Surface', 'web', '-DryRun', '-SkipBuild', '-All'], ['--dry-run', '--skip-build', '--all', '--profile', 'web', '--surface', 'web']],
      ['stable-install', ['-Profile', 'web', '-Platform', 'mac', '-DryRun'], ['--dry-run', '--profile', 'web', '--platform', 'mac']],
      ['status', ['-Profile', 'web'], ['--profile', 'web']],
      ['ci', [], []],
      ['ci', ['-TimeoutMs', '3333', '-TestBrowser', 'chromium'], ['--test-browser', 'chromium', '--timeout', '3333']],
    ]
    for (const [name, input, expected] of cases) {
      copyFileSync(join(repoRoot, `scripts/${name}.ps1`), join(scripts, `${name}.ps1`))
      const toolPath = join(root, 'tool with spaces.cmd')
      const result = runToFiles('pwsh', ['-NoProfile', '-File', join(scripts, `${name}.ps1`), ...input, '-DshCli', toolPath], {
        cwd: root, env: { ...process.env, DSH_NODE: process.execPath, DSH_CLI: 'inherited', TEST_TRACE: join(root, 'trace.json') }, timeoutMs: 15_000,
        stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log'),
      })
      assert.equal(result.status, 7, result.stderr)
      const trace = JSON.parse(readFileSync(join(root, 'trace.json'), 'utf8'))
      // CI appends an explicit timeout last, after optional tool flags.
      const args = expected.filter((_, index) => name !== 'ci' || !expected.includes('--timeout') || index < expected.indexOf('--timeout'))
      if (name === 'ci' && expected.includes('--timeout')) args.push('--dsh-cli', toolPath, '--timeout', '3333')
      else args.push('--dsh-cli', toolPath)
      assert.deepEqual(trace.args, [name, ...args])
      assert.equal(trace.cli, 'inherited', 'flags must not mutate inherited environment variables')
    }
  } finally { removeDir(root) }
})
