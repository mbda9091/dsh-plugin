import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixture, sourceRoot, snapshot } from './environment.js'
import { prepareDevelopment } from './development.js'
import { startToFiles, sleep, stopChild, waitForExit, waitForHttpClosed } from '../../../scripts/.build/core/exec.js'

export function prepareIsolation(f: ReturnType<typeof fixture>, real = false) {
  const d = prepareDevelopment(f)
  if (real) {
    assert.ok(process.env.DSH_ENV_TEST_PNPM, 'real suite requires --pnpm-script')
    const dependency = join(f.root, 'node_modules/@deepseek-ai/dsh')
    rmSync(dependency, { recursive: true })
    symlinkSync(realpathSync(join(sourceRoot, 'node_modules/@deepseek-ai/dsh')), dependency, process.platform === 'win32' ? 'junction' : 'dir')
    f.config.tools.pnpmScript = process.env.DSH_ENV_TEST_PNPM
  } else {
    writeFileSync(d.entry, `const fs=require('node:fs'),path=require('node:path');
      if(process.argv.includes('--dump-config')){fs.mkdirSync(process.env.DSH_PROFILE_DIR,{recursive:true});console.log('@deepseek-ai/dsh-base @deepseek-ai/dsh-web-app')}
      else {const server=require('node:http').createServer((req,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/'));}`)
  }
  f.write()
  const development = join(f.root, '.local/dsh-dev'); mkdirSync(development, { recursive: true }); writeFileSync(join(development, 'sentinel'), 'persistent')
  const npmrc = join(f.personal, '.npmrc'); writeFileSync(npmrc, `store-dir=${f.personal}\nregistry=http://personal.invalid\n//personal.invalid/:_authToken=fake-secret`)
  f.personalBefore = snapshot(f.personal)
  // Simulated user files are added intentionally before refreshing the immutable snapshot.
  const env = { ...d.env, npm_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: npmrc, PNPM_CONFIG_STORE_DIR: f.personal,
    pnpm_config_registry: 'http://personal.invalid', PNPM_HOME: f.personal, XDG_CONFIG_HOME: f.personal,
    DSH_PATCH: f.paths.patch, DSH_WEB_PORT: '1', DSH_STORE: f.personal, NPM_CONFIG_PREFIX: f.personal }
  const audit = join(f.root, 'read-audit.cjs')
  writeFileSync(audit, `const fs=require('node:fs'),path=require('node:path');
    const check=p=>{if(typeof p==='string'&&path.resolve(p).startsWith(${JSON.stringify(f.personal)}))throw new Error('personal read blocked: '+p)};
    for(const name of ['readFileSync','readFile','openSync','open']){const orig=fs[name];fs[name]=function(p,...args){check(p);return orig.call(this,p,...args)}}
    for(const name of ['readFile','open']){const orig=fs.promises[name];fs.promises[name]=function(p,...args){check(p);return orig.call(this,p,...args)}}
    require('node:module').syncBuiltinESMExports();`)
  Object.assign(env, { NODE_OPTIONS: `--require ${JSON.stringify(audit)}` })
  const script = join(f.root, 'isolation-worker.mjs')
  const mod = (name: string) => JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/.build/core', `${name}.js`)).href)
  writeFileSync(script, `
    import fs from 'node:fs'; import {join} from 'node:path';
    import {loadCommandContext} from ${mod('command-context')};
    import {runIsolatedTest} from ${mod('test-run')};
    import {childEnv,ensurePnpmShim,initProfile,runDsh,serveAndCheck} from ${mod('web-harness')};
    import {runToFilesAsync,sleep} from ${mod('exec')};
    const [root,id,mode]=process.argv.slice(2), settings=loadCommandContext({},root,process.env,'test');
    process.exitCode=await runIsolatedTest('iso',settings,{keep:mode==='keep',timeoutMs:60000},async c=>{
      await c.step('init',async()=>{ensurePnpmShim(c);await initProfile(c,'init',c.home);return 'initialized'});
      const env=childEnv(c,c.home);
      if(mode==='probe') await c.step('pnpm-config',async()=>{
        const result=await runToFilesAsync(process.execPath,[settings.config.tools.pnpmScript,'store','path'],{cwd:c.runDir,env,timeoutMs:30000,stdoutPath:join(c.logDir,'store.out'),stderrPath:join(c.logDir,'store.err')});
        if(result.status!==0||!result.stdout.trim().startsWith(join(c.runDir,'pnpm-store')))throw new Error('pnpm store escaped: '+result.stdout+result.stderr);
        return 'real pnpm store inside run';
      });
      fs.writeFileSync(join(root,id+'.env.json'),JSON.stringify({home:env.DSH_HOME,profile:env.DSH_PROFILE_DIR,store:env.pnpm_config_store_dir,userconfig:env.npm_config_userconfig,globalconfig:env.npm_config_globalconfig,config:env.XDG_CONFIG_HOME,patch:env.DSH_PATCH,web:env.DSH_WEB_URL}));
      if(mode==='install-fail') await c.step('install',()=>runDsh(c,'install',['plugin','--profile','web','add',join(root,'missing-package.tgz')],c.home).then(()=>''));
      if(mode==='start-fail') c.runner.build=()=>[c.runner.source,'web','--host','not-a-real-host.invalid'];
      await c.step('serve',()=>serveAndCheck(mode==='timeout'?{...c,options:{timeoutMs:1}}:c,'server',async url=>{
        fs.writeFileSync(join(root,id+'.ready'),JSON.stringify({runDir:c.runDir,home:c.home,url:url.replace(/\\?.*$/,''),pid:process.pid}));
        if(mode==='interrupt') {process.emit('SIGINT'); c.signal.throwIfAborted()}
        if(mode==='hold') while(!fs.existsSync(join(root,id+'.release'))){c.signal.throwIfAborted();await sleep(50)}
        if(mode==='check-fail') throw new Error('fake http://localhost/?token=FAKE_TOKEN Bearer FAKE_BEARER');
        return 'HTTP ready';
      }));
    },report=>fs.writeFileSync(join(root,id+'.report.json'),JSON.stringify(report)));
  `)
  return { script, env, development }
}

export async function isolationWorker(root: string, prepared: ReturnType<typeof prepareIsolation>, id: string, mode = 'success') {
  const started = startToFiles(process.execPath, [prepared.script, root, id, mode], {
    cwd: root, env: prepared.env, stdoutPath: join(root, `${id}.out`), stderrPath: join(root, `${id}.err`),
  })
  const finish = async () => {
    try { await waitForExit(started.child, 120_000) } finally { await stopChild(started.child) }
    assert.ok(existsSync(join(root, `${id}.report.json`)), readFileSync(join(root, `${id}.err`), 'utf8'))
    const report = JSON.parse(readFileSync(join(root, `${id}.report.json`), 'utf8'))
    assert.equal(started.child.exitCode, report.ok ? 0 : 1)
    const ready = join(root, `${id}.ready`)
    if (existsSync(ready)) await waitForHttpClosed(JSON.parse(readFileSync(ready, 'utf8')).url, 5000)
    return report
  }
  const ready = async () => {
    for (let i = 0; i < 1200; i++) {
      const path = join(root, `${id}.ready`)
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
      if (started.child.exitCode !== null) throw new Error(readFileSync(join(root, `${id}.err`), 'utf8'))
      await sleep(100)
    }
    throw new Error('worker readiness timeout')
  }
  return { started, finish, ready, release: () => writeFileSync(join(root, `${id}.release`), '') }
}
