import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sourceRoot, fixture } from './environment.js'
import { loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import { startToFiles, sleep, stopChild } from '../../../scripts/.build/core/exec.js'
import { developmentStatus, stopDevelopment } from '../../../scripts/.build/core/development-process.js'

export function prepareDevelopment(f: ReturnType<typeof fixture>) {
  const entry = f.fake()
  const pnpm = join(f.root, 'pnpm/bin/pnpm.cjs')
  mkdirSync(dirname(pnpm), { recursive: true }); writeFileSync(pnpm, '')
  writeFileSync(join(f.root, 'pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.28.5' }))
  copyFileSync(join(sourceRoot, 'profiles/web/cordis.dev.patch.yml'), join(f.root, 'profiles/web/cordis.dev.patch.yml'))
  Object.assign(f.config.tools, { pnpmScript: pnpm })
  Object.assign(f.config.web, { browser: 'default', openBrowser: false, startupTimeoutMs: 5000 })
  f.write()
  writeFileSync(entry, `
    const fs=require('node:fs'), path=require('node:path');
    if(process.argv.includes('--dump-config')) {
      fs.mkdirSync(process.env.DSH_PROFILE_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.DSH_PROFILE_DIR,'package.json'),'{}');
      console.log('@deepseek-ai/dsh-web-app');
    } else if(process.env.DEV_FAKE_TIMEOUT) { fs.writeFileSync(process.env.DEV_FAKE_TIMEOUT,String(process.pid)); setInterval(()=>{},1000); }
    else { const server=require('node:http').createServer((req,res)=>res.end('ready'));
      server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/')); }
  `)
  const env = { ...process.env, DSH_HOME: f.personal, DSH_PROFILE: 'daily', DSH_PROFILE_DIR: f.personal, DSH_WEB_URL: 'http://daily.invalid', DSH_PNPM: '', PNPM_CONFIG_STORE_DIR: f.personal }
  return { entry, pnpm, env, context: loadCommandContext({}, f.root, env, 'development') }
}

export async function launchDevelopment(root: string, env: NodeJS.ProcessEnv) {
  const script = join(root, 'supervisor.mjs')
  writeFileSync(script, `import {runWeb} from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/.build/commands/web.js')).href)}; try { process.exitCode=await runWeb(['--no-open','--port','0'],${JSON.stringify(root)}); } catch(e) { console.error(e); process.exitCode=1; }`)
  const started = startToFiles(process.execPath, [script], { cwd: root, env, stdoutPath: join(root, 'supervisor.out'), stderrPath: join(root, 'supervisor.err') })
  const context = loadCommandContext({}, root, env, 'development')
  try {
    const deadline = Date.now() + context.config.web.startupTimeoutMs + 10_000
    while (Date.now() < deadline) {
      try { if ((await developmentStatus(context)).startsWith('running')) return { started, context } } catch { /* starting */ }
      if (started.child.exitCode !== null) throw new Error('supervisor exited; inspect fixture logs')
      await sleep(100)
    }
    throw new Error('supervisor did not become ready')
  } catch (error) {
    try { await stopDevelopment(context) } finally { await stopChild(started.child) }
    throw error
  }
}
