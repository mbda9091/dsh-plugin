import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixture, sourceRoot } from './environment.js'
import { prepareDevelopment } from './development.js'
import { packageFixture, tarball, verificationFixture } from './artifacts.js'
import { describeArtifact, loadArtifacts, newBatch, publishManifest, sourceState } from '../../../scripts/.build/core/artifacts.js'
import { verificationPath } from '../../../scripts/.build/core/artifact-verification.js'
import { loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import type { DeliveryReport } from '../../../scripts/.build/commands/install-artifacts.js'

export function targetPackages(root: string, names = ['alpha', 'beta', 'gamma']) {
  const { batch, directory } = newBatch(root)
  const packages = names.map(name => {
    const f = packageFixture()
    for (const key of Object.keys(f.files)) f.files[key] = f.files[key]!.replaceAll('alpha', name)
    const path = `local-${name}-1.0.0.tgz`; writeFileSync(join(directory, path), tarball(f.files))
    return describeArtifact(join(directory, path), path)
  })
  const path = publishManifest(root, { version: 1, batch, createdAt: new Date().toISOString(), source: sourceState(root), tools: { node: process.version, pnpm: '11.28.5' }, packages })
  return loadArtifacts(root, path)
}
export function fakeAcceptance(set: ReturnType<typeof targetPackages>) {
  const path = verificationPath(set, process.platform === 'win32' ? 'windows' : 'mac')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(verificationFixture(set)))
}
export function prepareTarget(f: ReturnType<typeof fixture>) {
  const dev = prepareDevelopment(f), host = join(f.root, '.formal-host'), home = join(f.root, '.formal-home')
  mkdirSync(host)
  const cli = join(host, 'cli.cjs'), trace = join(f.root, '.target-trace'), mode = join(f.root, '.target-mode')
  const parser = JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/.build/core/artifact-package.js')).href)
  writeFileSync(cli, `const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
    const mode=fs.existsSync(${JSON.stringify(mode)})?fs.readFileSync(${JSON.stringify(mode)},'utf8'):'';
    if(args[0]==='--version'){console.log(mode==='version'?'0.9.0':'0.2.1-rc.2');process.exit(0)}
    if(args.includes('--dump-config')){const m=JSON.parse(fs.readFileSync(path.join(process.env.DSH_PROFILE_DIR,'package.json')));for(const name of m.dsh.profile.bundles)console.log('- id: '+name.slice(7)+'\\n  name: '+JSON.stringify(name));process.exit(0)}
    fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
    import(${parser}).then(({readPackage})=>{const p=readPackage(fs.readFileSync(args[4])),profile=process.env.DSH_PROFILE_DIR;
      if(mode==='second-fails'&&p.name==='@local/beta')process.exit(2);
      fs.mkdirSync(profile,{recursive:true});const file=path.join(profile,'package.json');
      const manifest=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
      manifest.dependencies??={};manifest.dependencies[p.name]='file:'+args[4];
      manifest.dsh??={profile:{bundles:[]}};if(!manifest.dsh.profile.bundles.includes(p.name))manifest.dsh.profile.bundles.push(p.name);
      fs.writeFileSync(file,JSON.stringify(manifest));
      if(mode==='warning')console.error('warning: test diagnostic');
      if(mode==='restart')console.log('restart-required');
      if(mode==='load-fail')console.error('application: failed');
    }).catch(e=>{console.error(e);process.exitCode=1});`)
  writeFileSync(dev.pnpm, `const fs=require('node:fs'),path=require('node:path');
    fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');
    import(${parser}).then(({readPackage})=>{const name=process.argv[3],spec=JSON.parse(fs.readFileSync('package.json')).dependencies[name];
      const p=readPackage(fs.readFileSync(path.resolve(spec.slice(5)))),dir=path.join('node_modules',name);
      if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())fs.unlinkSync(dir);
      for(const [file,bytes]of p.files){const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes)}
    }).catch(e=>{console.error(e);process.exitCode=1});`)
  const fields = { dshCli: cli, home, profile: 'web', surface: 'web', platform: process.platform === 'win32' ? 'windows' : 'mac' }
  const context = () => loadCommandContext(fields, f.root, dev.env, 'target')
  return { ...dev, cli, host, home, trace, mode, fields, context }
}
export const installOptions = (manifest: string) => ({ mode: 'tarball' as const, manifest, all: false, skipBuild: false, dryRun: false })
export const deliveryReport = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as DeliveryReport
