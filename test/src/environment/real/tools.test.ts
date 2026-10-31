import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { it } from 'node:test'
import { checkPnpm, workspaceDsh } from '../../../../scripts/.build/core/toolchain.js'
import { runToFiles } from '../../../../scripts/.build/core/exec.js'
import { writePnpmShim } from '../../../../scripts/.build/core/pnpm.js'
import { environmentCase, sourceRoot } from '../../harness/environment.js'

it('TOOL-04 clean frozen install, public CLI, internal pnpm and real tarball (TOOL-03/05 real)', { timeout: 600_000 }, () => environmentCase('TOOL-04', async f => {
  const selected = process.env.DSH_ENV_TEST_PNPM
  assert.ok(selected, 'real suite requires --pnpm-script pointing to prepared pnpm/bin/pnpm.cjs')
  checkPnpm(selected, sourceRoot)
  // A separate copy of the prepared public pnpm package makes the child PATH
  // independent of global DSH and private runtimes, without downloading tools.
  const tool = join(f.root, 'prepared-pnpm')
  cpSync(dirname(dirname(realpathSync(selected))), tool, { recursive: true })
  const pnpm = join(tool, 'bin/pnpm.cjs')
  const clean = join(f.root, 'checkout'); mkdirSync(clean)
  const tracked = runToFiles('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: sourceRoot, stdoutPath: join(f.root, 'sources.out'), stderrPath: join(f.root, 'sources.err'),
  })
  assert.equal(tracked.status, 0, tracked.stderr)
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (!existsSync(join(sourceRoot, file))) continue
    mkdirSync(dirname(join(clean, file)), { recursive: true }); copyFileSync(join(sourceRoot, file), join(clean, file))
  }
  assert.equal(existsSync(join(clean, 'node_modules')), false)
  assert.equal(existsSync(join(clean, 'scripts/config/local.json')), false)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(DSH_|NPM_|PNPM_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|COREPACK_|HOME$|USERPROFILE$|PATH$)/i.test(key)) delete env[key]
  const user = join(f.root, 'user'); mkdirSync(user)
  Object.assign(env, {
    HOME: user, USERPROFILE: user, DSH_HOME: join(f.root, 'home'),
    PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot!, 'System32')] : ['/usr/bin', '/bin'])].join(delimiter),
    npm_config_userconfig: join(user, '.npmrc'), npm_config_globalconfig: join(user, 'global.npmrc'),
    pnpm_config_store_dir: join(f.root, 'store'), npm_config_store_dir: join(f.root, 'store'),
    npm_config_cache: join(f.root, 'cache'), CI: 'true',
  })
  writeFileSync(env.npm_config_userconfig!, ''); writeFileSync(env.npm_config_globalconfig!, '')
  const trace = join(f.root, 'node-trace.jsonl')
  const hook = join(f.root, 'trace.cjs')
  writeFileSync(hook, `
    const fs = require('node:fs'), path = require('node:path'), url = require('node:url');
    fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({node:process.execPath,entry:process.argv[1]})+String.fromCharCode(10));
    require('node:module').registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('file:')) {
        const resolved = fs.realpathSync(url.fileURLToPath(result.url));
        const inside = path.relative(${JSON.stringify(f.root)}, resolved);
        if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
          throw new Error('clean install attempted ancestor/global module fallback: ' + specifier);
      }
      return result;
    }});
  `)
  env.NODE_OPTIONS = `--require ${JSON.stringify(hook)}`
  const evidence: { label: string; status: number | null }[] = []
  const run = (label: string, command: string, args: string[], cwd = clean) => {
    const result = runToFiles(command, args, { cwd, env, timeoutMs: 300_000, stdoutPath: join(f.root, `${label}.out`), stderrPath: join(f.root, `${label}.err`) })
    evidence.push({ label, status: result.status })
    assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`)
    return result.stdout
  }
  const lock = readFileSync(join(clean, 'pnpm-lock.yaml'))
  run('frozen-install', process.execPath, [pnpm, 'install', '--frozen-lockfile'])
  assert.deepEqual(readFileSync(join(clean, 'pnpm-lock.yaml')), lock)
  const host = workspaceDsh(clean)
  const bin = join(f.root, 'bin'); writePnpmShim(bin, pnpm); env.PATH = `${bin}${delimiter}${env.PATH}`
  assert.equal(run('dsh-version', host.command, host.build(['--version'])).trim(), host.version)
  const tree = run('profile', host.command, host.build(['--profile', 'web', '--dump-config']))
  assert.match(tree, /@deepseek-ai\/dsh-web-app/)
  const beforeInternal = readFileSync(trace, 'utf8').trim().split('\n').length
  assert.match(run('internal-pnpm', host.command, host.build(['plugin', '--profile', 'web', '--version'])), /11\.28\.5/)
  const internalRecords = readFileSync(trace, 'utf8').trim().split('\n').slice(beforeInternal).map(line => JSON.parse(line))
  assert.ok(internalRecords.some(record => record.entry === pnpm && record.node === process.execPath), 'DSH itself must invoke the selected pnpm on the current Node')
  run('config-init', process.execPath, ['scripts/bootstrap.mjs', 'config', 'init', '--pnpm-script', pnpm, '--browser', 'default', '--test-browser', 'chromium'])
  run('build-check', process.execPath, ['scripts/bootstrap.mjs', 'build', '--check'])
  run('build', process.execPath, ['scripts/bootstrap.mjs', 'build'])
  const artifacts = join(f.root, 'artifacts'); mkdirSync(artifacts)
  run('pack', process.execPath, [pnpm, 'pack', '--pack-destination', artifacts], join(clean, 'notify-web'))
  const pluginVersion = JSON.parse(readFileSync(join(clean, 'notify-web/package.json'), 'utf8')).version
  const tgz = join(artifacts, `local-notify-web-${pluginVersion}.tgz`)
  const files = run('tar-content', 'tar', ['-tf', tgz]).split(/\r?\n/).filter(Boolean)
  assert.ok(files.includes('package/lib/index.js')); assert.ok(files.includes('package/lib/client.js'))
  for (const file of files) assert.doesNotMatch(file, /node_modules|\.local\/|local\.json|\.credentials|node\.exe|dsh\/lib\/bin/)
  const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { node: string; entry: string })
  assert.ok(records.every(record => record.node === process.execPath))
  assert.ok(records.some(record => record.entry === host.source))
  assert.ok(records.some(record => record.entry === pnpm))
  assert.ok(records.some(record => /typescript[/\\]bin[/\\]tsc$/.test(record.entry)))
  writeFileSync(join(process.env.DSH_ENV_TEST_RUN!, 'TOOL-04-details.json'), JSON.stringify({ coverage: ['TOOL-03 real', 'TOOL-04', 'TOOL-05 real'], node: process.execPath, dsh: host.version, pnpm: '11.28.5', evidence, files, internalPnpmRecords: internalRecords, nodeRecords: records }, null, 2))
}, false))
