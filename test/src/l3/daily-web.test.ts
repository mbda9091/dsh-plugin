import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { it } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDailyWeb } from '../../../scripts/.build/commands/daily-web.js'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { sleep } from '../../../scripts/.build/core/exec.js'
import { configFixture, fakeWebServer } from '../harness/local-config.js'
import { removeDir } from '../harness/tmp.js'

function dailyFixture() {
  const f = configFixture()
  initializeConfig(f.options, f.root, f.env)
  const home = join(f.root, 'daily-home'), profile = join(home, 'profiles/macos-web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"private":true}')
  writeFileSync(join(home, 'history-sentinel'), 'existing daily data')
  const disk = JSON.parse(readFileSync(f.paths.local, 'utf8'))
  disk.targets = [{ name: 'macos-web', dshCli: f.cli, home, profile: 'macos-web', surface: 'web', platform: process.platform === 'win32' ? 'windows' : 'mac' }]
  writeFileSync(f.paths.local, JSON.stringify(disk))
  return { ...f, home, profile }
}

it('L3 daily Web selects the bound external target despite poisoned DSH variables; it never creates development data or applies an unconfigured patch', async () => {
  const f = dailyFixture()
  try {
    const capture = join(f.root, 'capture.json')
    writeFileSync(f.entry, `const fs=require('node:fs'); fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME,profile:process.env.DSH_PROFILE_DIR,cwd:process.cwd()})); ${fakeWebServer(7)}`)
    const before = readFileSync(join(f.profile, 'package.json'), 'utf8')
    assert.equal(await runDailyWeb(['--no-open', '--port', '0'], f.root, {
      ...process.env, ...f.env, DSH_CLI: 'wrong-cli', DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: 'wrong-profile', TEST_CAPTURE: capture,
    }), 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: ['--profile', 'macos-web', '--no-open', '--host', '127.0.0.1', '--port', '0'], home: f.home, profile: f.profile, cwd: f.home,
    })
    assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), before)
    assert.equal(readFileSync(join(f.home, 'history-sentinel'), 'utf8'), 'existing daily data')
    assert.equal(existsSync(join(f.root, '.local/dsh-dev')), false)
    assert.equal(existsSync(join(f.root, '.local/dsh-daily/macos-web/runtime.json')), false)
  } finally { removeDir(f.root) }
})

it('L3 daily Web forwards targets[].patch as one overlay and resolves it against the repository root', async () => {
  const f = dailyFixture()
  try {
    writeFileSync(join(f.root, 'model-providers.patch.yml'), '- id: llm-pi-ai\n  config: {}\n')
    const capture = join(f.root, 'capture.json')
    writeFileSync(f.entry, `const fs=require('node:fs'); fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2)})); ${fakeWebServer(7)}`)
    const disk = JSON.parse(readFileSync(f.paths.local, 'utf8'))
    disk.targets[0].patch = 'model-providers.patch.yml'
    writeFileSync(f.paths.local, JSON.stringify(disk))
    assert.equal(await runDailyWeb(['--no-open', '--port', '0'], f.root, { ...process.env, ...f.env, TEST_CAPTURE: capture }), 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')).args, [
      '--profile', 'macos-web', '--patch', join(f.root, 'model-providers.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', '0',
    ])
  } finally { removeDir(f.root) }
})

it('L3 daily Web fails closed when the configured target patch is missing', async () => {
  const f = dailyFixture()
  try {
    const disk = JSON.parse(readFileSync(f.paths.local, 'utf8'))
    disk.targets[0].patch = join(f.root, 'absent.patch.yml')
    writeFileSync(f.paths.local, JSON.stringify(disk))
    await assert.rejects(runDailyWeb(['--no-open', '--port', '0'], f.root, { ...process.env, ...f.env }), /targets\[\]\.patch: file does not exist/)
    assert.equal(existsSync(join(f.root, '.local/dsh-daily')), false)
  } finally { removeDir(f.root) }
})

it('L3 daily Web defaults are independent of browser preferences and stale supervisor/deployment records', async () => {
  const f = dailyFixture()
  try {
    const directory = join(f.root, '.local/dsh-daily/macos-web')
    mkdirSync(directory, { recursive: true })
    for (const name of ['runtime.json', 'operation.lock', 'deployment.json']) writeFileSync(join(directory, name), 'stale')
    const capture = join(f.root, 'capture.json')
    writeFileSync(f.entry, `require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify(process.argv.slice(2))); process.exit(7)`)
    assert.equal(await runDailyWeb([], f.root, { ...process.env, ...f.env, TEST_CAPTURE: capture }), 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['--profile', 'macos-web', '--no-open', '--host', '127.0.0.1', '--port', '3080'])
    for (const name of ['runtime.json', 'operation.lock', 'deployment.json']) assert.equal(readFileSync(join(directory, name), 'utf8'), 'stale')
    assert.equal(await runDailyWeb(['--target=macos-web', '--port=3099', '--open'], f.root, { ...process.env, ...f.env, TEST_CAPTURE: capture }), 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['--profile', 'macos-web', '--host', '127.0.0.1', '--port', '3099'])
  } finally { removeDir(f.root) }
})

it('L3 daily Web rejects removed management commands and invalid ports', async () => {
  for (const args of [['status'], ['stop'], ['check'], ['--port', '65536'], ['--port', '-1'], ['--port', 'abc'], ['--target'], ['--port', '1', '--port', '2']]) {
    await assert.rejects(runDailyWeb(args), /unsupported daily Web option|--port|--target/)
  }
})

// Windows kill(SIGTERM) forcibly terminates the wrapper, rather than delivering a catchable signal.
it('L3 daily Web forwards POSIX termination to its child and cleans up the temporary pnpm shim', { skip: process.platform === 'win32' }, async () => {
  const f = dailyFixture()
  let child: ReturnType<typeof spawn> | undefined
  let running: Promise<number | null> | undefined
  try {
    const ready = join(f.root, 'ready.json')
    writeFileSync(f.entry, `const fs=require('node:fs'); process.on('SIGTERM',()=>process.exit(23)); fs.writeFileSync(process.env.TEST_READY,JSON.stringify({bin:process.env.PATH.split(require('node:path').delimiter)[0]})); setInterval(()=>{},1000);`)
    const wrapper = join(f.root, 'wrapper.mjs')
    const entry = new URL('../../../scripts/.build/commands/daily-web.js', import.meta.url).href
    writeFileSync(wrapper, `import { runDailyWeb } from ${JSON.stringify(entry)}; process.exitCode = await runDailyWeb([], ${JSON.stringify(f.root)});`)
    child = spawn(process.execPath, [wrapper], { env: { ...process.env, ...f.env, TEST_READY: ready }, stdio: 'inherit' })
    running = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('exit', resolve) })
    const deadline = Date.now() + 5000
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline, 'child did not start')
      await sleep(20)
    }
    const { bin } = JSON.parse(readFileSync(ready, 'utf8'))
    assert.equal(existsSync(bin), true)
    child.kill('SIGTERM')
    assert.equal(await running, 23)
    running = undefined
    assert.equal(existsSync(bin), false)
    assert.equal(existsSync(join(f.root, '.local/dsh-daily')), false)
  } finally {
    if (running) { child?.kill('SIGTERM'); await running }
    removeDir(f.root)
  }
})

it('L3 daily Web fails closed for absent targets, uninitialized profiles and destructive development actions', async () => {
  const f = dailyFixture()
  try {
    await assert.rejects(runDailyWeb(['--target', 'missing'], f.root, f.env), /unknown named target/)
    for (const action of ['init', 'reset', 'reset --yes']) {
      await assert.rejects(runDailyWeb(action.split(' '), f.root, f.env), /unsupported daily Web option/)
    }
    const disk = JSON.parse(readFileSync(f.paths.local, 'utf8'))
    disk.targets[0].profile = 'uninitialized'
    writeFileSync(f.paths.local, JSON.stringify(disk))
    await assert.rejects(runDailyWeb(['--no-open'], f.root, f.env), /existing initialized profile/)
    assert.equal(existsSync(join(f.root, '.local/dsh-daily')), false)
  } finally { removeDir(f.root) }
})
