import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { runWeb } from '../../../scripts/.build/commands/web.js'
import { configFixture } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

it('L3 Web launcher uses initialized config from another cwd, forwards args and returns the child exit code', async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    const capture = join(f.root, 'capture.json')
    writeFileSync(f.entry, `#!/usr/bin/env node
      require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), patch: require('node:fs').readFileSync(process.argv[4], 'utf8'),
      }));
      console.log('dsh web: http://127.0.0.1:12345/');
      setTimeout(() => process.exit(7), 300);
    `)
    const before = readFileSync(f.paths.local, 'utf8')
    const listeners = process.listenerCount('SIGINT')
    const code = await runWeb(['--no-open', '--port', '0'], f.root, {
      ...process.env, DSH_CLI: '', DSH_PNPM: '', CHROME_PATH: '', DSH_E2E_BROWSER: '', TEST_CAPTURE: capture,
    })
    assert.equal(code, 7)
    const recorded = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; cwd: string; patch: string }
    assert.deepEqual(recorded.args, ['web', '--patch', f.paths.patch, '--no-open', '--port', '0'])
    assert.equal(recorded.cwd, f.root)
    assert.equal(recorded.patch, readFileSync(f.paths.patch, 'utf8'))
    assert.equal(readFileSync(f.paths.local, 'utf8'), before)
    assert.equal(process.listenerCount('SIGINT'), listeners)
    assert.equal(existsSync(join(f.root, '.tmp/web')), false)
  } finally { removeDir(f.root) }
})

it('L3 Web startup timeout redacts diagnostics and terminates the server', async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    const capture = join(f.root, 'pid.json')
    writeFileSync(f.entry, `#!/usr/bin/env node
      require('node:fs').writeFileSync(process.env.TEST_CAPTURE, String(process.pid));
      console.error('failure at http://127.0.0.1/?token=private-test-token');
      setInterval(() => {}, 1000);
    `)
    await assert.rejects(runWeb(['--no-open', '--startup-timeout', '1000'], f.root, {
      ...process.env, DSH_CLI: '', DSH_PNPM: '', CHROME_PATH: '', DSH_E2E_BROWSER: '', TEST_CAPTURE: capture,
    }), error => error instanceof Error && /did not print a URL/.test(error.message)
      && !error.message.includes('private-test-token'))
    const pid = Number(readFileSync(capture, 'utf8'))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { removeDir(f.root) }
})

it('L3 Web default browser passes the URL to the OS handler without a PowerShell subprocess', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, async (t) => {
  const f = configFixture()
  const spawn = childProcess.spawn
  const opened: Array<{ command: string; args: readonly string[] }> = []
  const url = 'http://127.0.0.1:12345/?a=1&b=two%20words'
  try {
    initializeConfig(f.options, f.root, f.env)
    writeFileSync(f.entry, `#!/usr/bin/env node\nconsole.log('dsh web: ${url}'); setTimeout(() => process.exit(0), 500);`)
    t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      if (command === 'open' || command.endsWith('rundll32.exe')) {
        opened.push({ command, args })
        return spawn(process.execPath, ['-e', ''], options)
      }
      return spawn(command, args, options)
    })
    syncBuiltinESMExports()
    assert.equal(await runWeb(['--open', '--browser', 'default'], f.root, { ...process.env, ...f.env, PATH: process.env.PATH, DSH_CLI: '', DSH_PNPM: '', CHROME_PATH: '', DSH_E2E_BROWSER: '' }), 0)
    assert.equal(opened.length, 1)
    assert.deepEqual(opened[0]?.args, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url])
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    removeDir(f.root)
  }
})
