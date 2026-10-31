import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDailyRelease, publishDaily } from '../../../scripts/.build/commands/daily-launcher.js'
import { dailyHash } from '../../../scripts/.build/core/daily-contract.js'
import type { DailyConfig } from '../../../scripts/.build/core/daily-contract.js'
import { runToFilesAsync, sleep, startToFiles, stopChild, waitForExit } from '../../../scripts/.build/core/exec.js'

export function dailyFixture(base: string) {
  const repo = join(base, 'repository'), external = join(base, 'external'), home = join(base, 'daily-home'), host = join(base, 'system-host')
  for (const dir of [repo, external, join(home, 'profiles/web'), join(host, 'lib'), join(base, 'pnpm/bin')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"packageManager":"pnpm@11.28.5"}')
  writeFileSync(join(home, 'profiles/web/package.json'), '{}')
  writeFileSync(join(home, 'history.sentinel'), 'original history')
  const entry = join(host, 'lib/bin.js'), capture = join(home, 'capture.json')
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', bin: { dsh: 'lib/bin.js' } }))
  writeFileSync(entry, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),home:process.env.DSH_HOME,profile:process.env.DSH_PROFILE_DIR,patch:process.env.DSH_PATCH,electron:process.env.ELECTRON_RUN_AS_NODE,registry:process.env.npm_config_registry,store:process.env.pnpm_config_store_dir}));const server=require('node:http').createServer((req,res)=>res.end('ready'));server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/'));`)
  const pnpm = join(base, 'pnpm/bin/pnpm.cjs'); writeFileSync(pnpm, '')
  writeFileSync(join(base, 'pnpm/package.json'), '{"name":"pnpm","version":"11.28.5"}')
  const node = realpathSync(process.execPath)
  const config: DailyConfig = { version: 1, instanceId: randomUUID(), host: { node, nodeVersion: process.versions.node, cli: entry, entry, version: '0.2.1-rc.2', hashes: { [node]: dailyHash(readFileSync(node)), [entry]: dailyHash(readFileSync(entry)) } },
    target: { home, directory: join(home, 'profiles/web'), profile: 'web', surface: 'web', platform: 'windows' }, packageManager: { script: pnpm, version: '11.28.5', sha256: dailyHash(readFileSync(pnpm)) },
    web: { host: '127.0.0.1', port: 0, openBrowser: false, browserPath: null, startupTimeoutMs: 10000 }, isolation: { forbiddenRoots: [repo] } }
  const candidate = join(repo, 'dist/candidate'), built = buildDailyRelease(candidate)
  writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ version: 1, ...built, node: process.version, platform: process.platform, surface: 'web', tools: { dsh: config.host.version, pnpm: config.packageManager.version } }))
  publishDaily(candidate, external, config)
  const command = async (args: string[]) => runToFilesAsync(node, [join(external, 'bin/dshweb.mjs'), ...args], { cwd: home, timeoutMs: 30000, stdoutPath: join(base, 'command.out'), stderrPath: join(base, 'command.err') })
  const start = async (env = process.env) => {
    const child = startToFiles(node, [join(external, 'bin/dshweb.mjs'), '--no-open'], { cwd: home, env, stdoutPath: join(base, 'start.out'), stderrPath: join(base, 'start.err') })
    try {
      const path = join(external, 'state', config.instanceId, 'runtime.json'), deadline = Date.now() + 20000
      while (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).state !== 'running') {
        assert.equal(child.child.exitCode, null, readFileSync(join(base, 'start.err'), 'utf8'))
        assert.ok(Date.now() < deadline, 'daily readiness timed out'); await sleep(30)
      }
      return child
    } catch (error) { await stopChild(child.child); throw error }
  }
  const stop = async (child: Awaited<ReturnType<typeof start>>) => {
    assert.equal((await command(['stop'])).status, 0)
    await waitForExit(child.child, 30000)
    assert.equal(child.child.exitCode, 0)
  }
  return { repo, external, home, host, entry, capture, pnpm, config, candidate, built, command, start, stop }
}
