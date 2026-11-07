import assert from 'node:assert/strict'
import { it } from 'node:test'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { runToTemporaryFiles } from '../../../scripts/.build/core/exec.js'
import { assertFileOnlyProbe } from '../harness/file-only-probe.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'

it('L1 discovery capture cleans files after success, failure, timeout and spawn errors without pipes', () => {
  const root = makeTempDir('tool-probe')
  try {
    const run = (script: string, timeoutMs = 5000) => assertFileOnlyProbe(() =>
      runToTemporaryFiles(root, process.execPath, ['-e', script], { timeoutMs }))
    const success = run('console.log("value"); console.error("diagnostic")')
    assert.equal(success.status, 0)
    assert.equal(success.stdout.trim(), 'value')
    assert.equal(success.stderr.trim(), 'diagnostic')
    assert.equal(run('process.exit(7)').status, 7)
    assert.equal(run('setInterval(() => {}, 1000)', 100).timedOut, true)
    assert.throws(() => assertFileOnlyProbe(() =>
      runToTemporaryFiles(root, join(root, 'missing-executable'), [], {})), /cannot run/)
    assert.deepEqual(readdirSync(join(root, '.tmp/tool-probes')), [])
  } finally { removeDir(root) }
})
