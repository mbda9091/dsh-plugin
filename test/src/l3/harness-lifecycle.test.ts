import assert from 'node:assert/strict'
import { it } from 'node:test'
import { join } from 'node:path'
import { freshHome } from '../../../scripts/.build/core/web-harness.js'
import { runToFiles, startToFiles, stopChild, waitForHttp, waitForHttpClosed, waitForServerUrl } from '../../../scripts/.build/core/exec.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

it('L3 harness: refuses existing or out-of-workspace homes before touching profiles', () => {
  const runDir = makeTempDir('home-safety-')
  try {
    assert.equal(freshHome(runDir), join(runDir, 'dsh-home'))
    assert.throws(() => freshHome(runDir, runDir), /new directory/)
    assert.throws(() => freshHome(runDir, join(repoRoot, 'user-home')), /new directory/)
  } finally { removeDir(runDir) }
})

it('L3 harness: reports spawn failures and safely cleans up a child with no PID', async () => {
  const directory = makeTempDir('spawn-failure-')
  const paths = { stdoutPath: join(directory, 'out.log'), stderrPath: join(directory, 'err.log') }
  try {
    const command = join(directory, 'no-such-executable')
    assert.throws(() => runToFiles(command, [], paths), /cannot run.*ENOENT/)
    const child = startToFiles(command, [], paths)
    await assert.rejects(waitForServerUrl(child, { urlPattern: /(http:\/\/\S+)/, timeoutMs: 1000 }), /cannot start server.*ENOENT/)
    await stopChild(child.child, 100)
  } finally { removeDir(directory) }
})

it('L3 harness: hung HTTP requests respect deadlines and do not count as closed ports', async (t) => {
  // A pending transport which observes abort, without requiring sandbox sockets.
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  const keepAlive = setTimeout(() => {}, 5000)
  const url = 'http://127.0.0.1:12345/'
  try {
    const start = Date.now()
    await assert.rejects(waitForHttp(url, 150, 10), /no HTTP response/)
    assert.ok(Date.now() - start < 3000, 'deadline was ignored')
    await assert.rejects(waitForHttpClosed(url, 150, 10), /timeout|aborted/i)
  } finally {
    clearTimeout(keepAlive)
  }
})
