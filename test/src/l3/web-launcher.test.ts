import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { runWeb } from '../../../scripts/.build/commands/web.js'
import { configFixture, developmentPatch, fakeWebServer } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

it('L3 Web launcher uses initialized config from another cwd, forwards args and returns the child exit code', async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    const patch = developmentPatch(f)
    const capture = join(f.root, 'capture.json')
    writeFileSync(f.entry, `#!/usr/bin/env node
      require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), patch: require('node:fs').readFileSync(process.argv[4], 'utf8'),
        pnpmShim: require('node:fs').readFileSync(require('node:path').join(process.env.PATH.split(require('node:path').delimiter)[0], process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), 'utf8'),
      }));
      ${fakeWebServer(7)}
    `)
    const before = readFileSync(f.paths.local, 'utf8')
    const listeners = process.listenerCount('SIGINT')
    const code = await runWeb(['--no-open', '--port', '0'], f.root, {
      ...process.env, DSH_CLI: '', DSH_PNPM: '', CHROME_PATH: '', DSH_E2E_BROWSER: '', TEST_CAPTURE: capture,
    })
    assert.equal(code, 7)
    const recorded = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; cwd: string; patch: string; pnpmShim: string }
    assert.deepEqual(recorded.args, ['web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'])
    assert.equal(recorded.cwd, f.root)
    assert.equal(recorded.patch, readFileSync(patch, 'utf8'))
    assert.ok(recorded.pnpmShim.includes(process.execPath))
    assert.ok(recorded.pnpmShim.includes(f.options.pnpmScript.replaceAll("'", "'\\''")) || recorded.pnpmShim.includes(f.options.pnpmScript))
    assert.equal(readFileSync(f.paths.local, 'utf8'), before)
    assert.equal(process.listenerCount('SIGINT'), listeners)
    assert.equal(existsSync(join(f.root, '.tmp/web')), false)
  } finally { removeDir(f.root) }
})

it('L3 Web startup timeout redacts diagnostics and terminates the server', async () => {
  const f = configFixture()
  try {
    initializeConfig(f.options, f.root, f.env)
    developmentPatch(f)
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
  const urlPath = join(f.root, 'url.txt')
  try {
    initializeConfig(f.options, f.root, f.env)
    developmentPatch(f)
    writeFileSync(f.entry, `#!/usr/bin/env node\n${fakeWebServer(0, '?a=1&b=two%20words')}`)
    t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      if (command === 'open' || command.endsWith('rundll32.exe')) {
        opened.push({ command, args })
        return spawn(process.execPath, ['-e', ''], options)
      }
      return spawn(command, args, options)
    })
    syncBuiltinESMExports()
    assert.equal(await runWeb(['--open', '--browser', 'default', '--port', '0'], f.root, { ...process.env, ...f.env, PATH: process.env.PATH, TEST_URL: urlPath, DSH_CLI: '', DSH_PNPM: '', CHROME_PATH: '', DSH_E2E_BROWSER: '' }), 0)
    assert.equal(opened.length, 1)
    const url = readFileSync(urlPath, 'utf8')
    assert.deepEqual(opened[0]?.args, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url])
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    removeDir(f.root)
  }
})
