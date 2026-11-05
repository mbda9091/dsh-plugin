import assert from 'node:assert/strict'
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
  disk.targets = [{ name: 'daily', dshCli: f.cli, home, profile: 'macos-web', surface: 'web', platform: process.platform === 'win32' ? 'windows' : 'mac' }]
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
    assert.equal(existsSync(join(f.root, '.local/dsh-daily/daily/runtime.json')), false)
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

it('L3 daily Web status/stop authenticate their own supervisor and retain daily data', async () => {
  const f = dailyFixture()
  let running: Promise<number> | undefined
  try {
    writeFileSync(f.entry, `const server=require('node:http').createServer((req,res)=>res.end('ready')); server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/'));`)
    running = runDailyWeb(['--no-open', '--port', '0'], f.root, { ...process.env, ...f.env })
    const runtime = join(f.root, '.local/dsh-daily/daily/runtime.json')
    const deadline = Date.now() + 5000
    while (!existsSync(runtime) || JSON.parse(readFileSync(runtime, 'utf8')).state !== 'running') {
      assert.ok(Date.now() < deadline, 'daily supervisor did not become ready')
      await sleep(20)
    }
    assert.equal(await runDailyWeb(['status'], f.root, f.env), 0)
    assert.equal(await runDailyWeb(['stop'], f.root, f.env), 0)
    assert.equal(await running, 0)
    assert.equal(existsSync(runtime), false)
    assert.equal(readFileSync(join(f.home, 'history-sentinel'), 'utf8'), 'existing daily data')
  } finally {
    if (running) { await runDailyWeb(['stop'], f.root, f.env); await running }
    removeDir(f.root)
  }
})

it('L3 daily Web fails closed for absent targets, uninitialized profiles and destructive development actions', async () => {
  const f = dailyFixture()
  try {
    await assert.rejects(runDailyWeb(['--target', 'missing'], f.root, f.env), /unknown named target/)
    for (const action of ['init', 'reset', 'reset --yes']) {
      await assert.rejects(runDailyWeb(action.split(' '), f.root, f.env), /no init\/reset/)
    }
    const disk = JSON.parse(readFileSync(f.paths.local, 'utf8'))
    disk.targets[0].profile = 'uninitialized'
    writeFileSync(f.paths.local, JSON.stringify(disk))
    await assert.rejects(runDailyWeb(['--no-open'], f.root, f.env), /existing initialized profile/)
    assert.equal(existsSync(join(f.root, '.local/dsh-daily')), false)
  } finally { removeDir(f.root) }
})
