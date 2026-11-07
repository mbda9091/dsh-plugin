import { workspaceDshVersion } from '../harness/dsh-version.js'
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
    for (const file of ['scripts/bootstrap.mjs', 'scripts/dev.mjs', 'scripts/install.mjs', 'scripts/launch.mjs', 'scripts/tsconfig.json', 'tsconfig.base.json', 'package.json']) {
      copyFileSync(join(repoRoot, file), join(f.root, file))
    }
    const manifest = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'))
    manifest.devDependencies['@deepseek-ai/dsh'] = workspaceDshVersion
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
    const run = (args: string[], code = 0, command = process.execPath, entry = 'dev.mjs') => {
      const result = runToFiles(command, [join(f.root, 'scripts', entry), ...args], {
        cwd, env, timeoutMs: 60_000, stdoutPath: join(f.root, 'stdout.log'), stderrPath: join(f.root, 'stderr.log'),
      })
      assert.equal(result.status, code, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
      return result
    }
    const help = run(['--help'], 0, 'node')
    assert.match(help.stdout, /Development\/testing only/)
    assert.doesNotMatch(help.stdout, /\.ps1/)
    assert.match(run(['web'], 1).stderr, /daily launch entry removed/)
    assert.match(run(['status'], 1).stderr, /unknown command/)
    assert.match(run(['install', '--profile', 'web'], 1).stderr, /unknown command/)
    assert.match(run(['build'], 1, process.execPath, 'install.mjs').stderr, /unsupported installation command/)
    assert.match(run(['install'], 1, process.execPath, 'install.mjs').stderr, /--profile is required/)
    assert.match(run([], 1, process.execPath, 'bootstrap.mjs').stderr, /Combined entry removed/)
    assert.equal(existsSync(f.paths.local), false)
    env.DSH_PNPM = f.options.pnpmScript
    writeFileSync(f.paths.local, 'invalid legacy JSON must be ignored')
    assert.match(run(['dev-web', '--help']).stdout, /OS-assigned port/)
    const before = [f.paths.local].map(path => readFileSync(path, 'utf8'))
    for (const name of ['app-restart', 'desktop-notify', 'notify-web']) mkdirSync(join(f.root, name, 'lib'), { recursive: true })
    mkdirSync(join(f.root, 'alpha/lib'), { recursive: true })
    writeFileSync(join(f.root, 'alpha/lib/index.js'), '')
    writeFileSync(join(f.root, 'alpha/package.json'), JSON.stringify({
      name: '@mbda9091/alpha', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' }, targets: { surfaces: ['web'], platforms: ['windows', 'mac'] } },
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
    run(['dev-web', '--no-open', '--port', '0', '--host', '127.0.0.1'], 7)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: ['web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], cwd: f.root,
    })
    mkdirSync(join(env.DSH_HOME!, 'profiles/web'), { recursive: true })
    writeFileSync(join(env.DSH_HOME!, 'profiles/web/package.json'), '{"dependencies":{}}')
    const platform = process.platform === 'win32' ? 'windows' : 'mac'
    assert.match(run(['status', '--dsh-cli', f.cli, '--home', env.DSH_HOME!, '--profile', 'web', '--platform', platform], 0, process.execPath, 'install.mjs').stdout, /@mbda9091\/alpha/)
    assert.match(run(['build', '--unknown'], 1).stderr, /Unknown option/)
    assert.equal(existsSync(f.paths.patch), false)
    assert.deepEqual([f.paths.local].map(path => readFileSync(path, 'utf8')), before)
    assert.match(run([]).stdout, /Development\/testing only/)
    assert.match(run(['test', '--unknown'], 1).stderr, /Unknown option/)
    assert.match(run(['unknown-command'], 1).stderr, /unknown command/i)
  } finally {
    removeDir(f.root)
  }
})
