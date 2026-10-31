import assert from 'node:assert/strict'
import { it } from 'node:test'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runToFiles } from '../../../scripts/.build/core/exec.js'
import { configFixture, developmentPatch, fakeWebServer } from '../harness/local-config.js'
import { removeDir, repoRoot } from '../harness/tmp.js'

it('L3 Node bootstrap works without PS wrappers from another cwd and a spaced, Chinese, quoted source path', () => {
  const f = configFixture()
  try {
    // Compile real sources in an isolated checkout; never copy generated output
    // or personal config. Only the installed compiler/libraries are shared.
    cpSync(join(repoRoot, 'scripts/src'), join(f.root, 'scripts/src'), { recursive: true })
    for (const file of ['scripts/bootstrap.mjs', 'scripts/tsconfig.json', 'tsconfig.base.json', 'package.json']) {
      copyFileSync(join(repoRoot, file), join(f.root, file))
    }
    const manifest = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'))
    manifest.devDependencies['@deepseek-ai/dsh'] = '0.2.1-rc.2'
    writeFileSync(join(f.root, 'package.json'), JSON.stringify(manifest))
    // bootstrap requires a local compiler; other dependencies resolve from the
    // workspace ancestor. Copying avoids requiring symlink privileges on Windows.
    cpSync(join(repoRoot, 'node_modules/typescript'), join(f.root, 'node_modules/typescript'), { recursive: true, dereference: true })
    const cwd = join(f.root, 'unrelated cwd')
    mkdirSync(cwd)
    // The only PATH entry is Node: no pwsh and no shell-based runtime discovery.
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(PATH|DSH_.*|CHROME_PATH|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(key)) delete env[key]
    }
    Object.assign(env, { PATH: dirname(process.execPath), DSH_HOME: join(f.root, 'home'), DSH_NODE: 'must-not-be-used' })
    const run = (args: string[], code = 0, command = process.execPath) => {
      const result = runToFiles(command, [join(f.root, 'scripts/bootstrap.mjs'), ...args], {
        cwd, env, timeoutMs: 60_000, stdoutPath: join(f.root, 'stdout.log'), stderrPath: join(f.root, 'stderr.log'),
      })
      assert.equal(result.status, code, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
      return result
    }
    const help = run(['--help'], 0, 'node')
    assert.match(help.stdout, /config init/)
    assert.doesNotMatch(help.stdout, /\.ps1/)
    assert.match(run(['web', '--help']).stdout, /node scripts\/bootstrap\.mjs web/)
    assert.match(run(['status'], 1).stderr, /node scripts\/bootstrap\.mjs config init/)
    const init = ['config', 'init', '--pnpm-script', f.options.pnpmScript, '--browser', 'default', '--test-browser', 'chromium']
    run([...init, '--dry-run'])
    assert.equal(existsSync(f.paths.local), false)
    assert.equal(existsSync(f.paths.patch), false)
    run(init)
    const before = [f.paths.local].map(path => readFileSync(path, 'utf8'))
    run(init)
    for (const name of ['app-restart', 'approval-allowlist', 'desktop-notify', 'notify-web']) mkdirSync(join(f.root, name, 'lib'), { recursive: true })
    run(['config', 'check'])
    mkdirSync(join(f.root, 'alpha/lib'), { recursive: true })
    writeFileSync(join(f.root, 'alpha/lib/index.js'), '')
    writeFileSync(join(f.root, 'alpha/package.json'), JSON.stringify({
      name: '@local/alpha', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' }, targets: { surfaces: ['web'], platforms: ['windows', 'mac'] } },
    }))
    const install = ['dev-install']
    assert.match(run([...install, '--dry-run']).stdout, /dsh plugin --profile web add/)
    assert.equal(existsSync(env.DSH_HOME!), false)
    const capture = join(f.root, 'capture.json')
    env.TEST_CAPTURE = capture
    const patch = developmentPatch(f)
    writeFileSync(f.entry, `#!/usr/bin/env node\nconst fs = require('node:fs');
      fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));
      if (process.argv[2] === 'web') { ${fakeWebServer(7)} }
      else process.exit(7);
    `)
    run([...install, '--skip-build'], 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')).args, ['plugin', '--profile', 'web', 'add', join(f.root, 'alpha')])
    run(['web', '--no-open', '--port', '0', '--host', '127.0.0.1'], 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: ['web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], cwd: f.root,
    })
    mkdirSync(join(env.DSH_HOME!, 'profiles/web'), { recursive: true })
    writeFileSync(join(env.DSH_HOME!, 'profiles/web/package.json'), '{"dependencies":{}}')
    const platform = process.platform === 'win32' ? 'windows' : 'mac'
    assert.match(run(['status', '--dsh-cli', f.cli, '--home', env.DSH_HOME!, '--profile', 'web', '--surface', 'web', '--platform', platform]).stdout, /@local\/alpha/)
    assert.match(run(['build', '--unknown'], 1).stderr, /Unknown option/)
    assert.equal(existsSync(f.paths.patch), false)
    assert.deepEqual([f.paths.local].map(path => readFileSync(path, 'utf8')), before)
  } finally {
    removeDir(f.root)
  }
})
