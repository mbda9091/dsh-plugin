import assert from 'node:assert/strict'
import { it } from 'node:test'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { configFixture } from '../harness/local-config.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'
import { artifactFixture, verificationFixture } from '../harness/artifacts.js'
import { initializeConfig } from '../../../scripts/.build/commands/config.js'
import { loadCommandContext } from '../../../scripts/.build/core/command-context.js'
import { verificationPath } from '../../../scripts/.build/core/artifact-verification.js'
import { runInstall } from '../../../scripts/.build/commands/install.js'
import { resolveTarget } from '../../../scripts/.build/core/targets.js'

it('L3 artifact delivery validates evidence before target writes and installs the same bytes through add/update', async () => {
  const f = configFixture(), home = makeTempDir('artifact-target')
  const directory = join(home, 'profiles/web'), trace = join(f.root, '.trace')
  try {
    initializeConfig(f.options, f.root, f.env)
    const parser = pathToFileURL(join(repoRoot, 'scripts/.build/core/artifact-package.js')).href
    writeFileSync(f.entry, `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
      if(args[0]==='--version'){console.log('0.2.1-rc.2');process.exit(0)}
      if(args.includes('--dump-config')){console.log("- id: alpha\\n  name: '@local/alpha'");process.exit(0)}
      fs.appendFileSync(${JSON.stringify(trace)},'add\\n');
      import(${JSON.stringify(parser)}).then(({readPackage})=>{const p=readPackage(fs.readFileSync(args[4])),profile=process.env.DSH_PROFILE_DIR;
        for(const [file,bytes] of p.files){const dest=path.join(profile,'node_modules',p.name,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes)}
        fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dependencies:{[p.name]:'file:'+args[4]},dsh:{profile:{bundles:[p.name]}}}));
      }).catch(e=>{console.error(e);process.exitCode=1});`)
    writeFileSync(f.options.pnpmScript, `require('node:fs').appendFileSync(${JSON.stringify(trace)},'update\\n')`)
    const set = artifactFixture(f.root), target = resolveTarget({ surface: 'web' })
    const context = loadCommandContext({ dshCli: f.cli, home, profile: 'web', surface: 'web', platform: target.platform }, f.root, f.env, 'target')
    const options = { mode: 'tarball' as const, manifest: set.path, all: false, skipBuild: false, dryRun: false }
    await assert.rejects(runInstall(options, context), /ENOENT/)
    assert.equal(existsSync(directory), false); assert.equal(existsSync(trace), false)
    const path = verificationPath(set, target.platform); mkdirSync(dirname(path), { recursive: true })
    const record = verificationFixture(set)
    writeFileSync(path, JSON.stringify({ ...record, contracts: [] }))
    await assert.rejects(runInstall(options, context), /contract/)
    assert.equal(existsSync(directory), false)
    writeFileSync(path, JSON.stringify(record))
    assert.equal(await runInstall({ ...options, dryRun: true }, context), 0)
    assert.equal(existsSync(directory), false)
    assert.equal(await runInstall(options, context), 0)
    assert.equal(readFileSync(trace, 'utf8'), 'add\nupdate\n')
    const spec = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies['@local/alpha'] as string
    assert.ok(existsSync(spec.slice(5)), 'stable spec references a persistent snapshot outside .tmp')
    assert.ok(spec.includes('dist') && spec.includes('consumption'))
  } finally { removeDir(home); removeDir(f.root) }
})
