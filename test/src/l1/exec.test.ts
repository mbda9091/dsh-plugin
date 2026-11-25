import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import { join } from 'node:path'
import { hasUnstoppedOwnedProcesses, startToFiles, stopOwnedTree, waitForExit } from '../../../scripts/.build/core/exec.js'
import { makeTempDir, removeDir } from '../harness/tmp.js'

it('process cleanup: signal rejection during exit waits for confirmed group disappearance', { skip: process.platform === 'win32' }, async () => {
  const root = makeTempDir('process-exit-race')
  const started = startToFiles(process.execPath, ['-e', ''], {
    ownProcessTree: true, stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log'),
  })
  await waitForExit(started.child, 10_000)
  const kill = process.kill.bind(process)
  let probes = 0, rejected = false
  const mocked = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -started.child.pid!) {
      if (signal === 0 && probes++ === 0) return true // Group observed just before exit.
      if (signal === 'SIGTERM') {
        rejected = true
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }
    }
    return kill(pid, signal)
  })
  try {
    await stopOwnedTree(started.child)
    assert.equal(rejected, true)
    assert.ok(probes >= 2)
    assert.equal(hasUnstoppedOwnedProcesses(), false)
  } finally {
    mocked.mock.restore()
    await stopOwnedTree(started.child)
    removeDir(root)
  }
})
