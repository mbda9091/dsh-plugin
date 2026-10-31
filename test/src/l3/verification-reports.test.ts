import assert from 'node:assert/strict'
import { it } from 'node:test'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { runToFiles } from '../../../scripts/.build/core/exec.js'
import { assertBrowserResults } from '../../../scripts/.build/core/browser-results.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

/** Exercise the real orchestration in an isolated repository with fake stages.
 * No user profiles, real builds, or latest reports are modified by these failures.
 */
function fixture(): string {
  const root = makeTempDir('verification-report')
  cpSync(join(repoRoot, 'scripts/.build'), join(root, 'scripts/.build'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module","packageManager":"pnpm@11.28.5"}')
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/config/example.json'), 'utf8'))
  config.tools.pnpmScript = join(root, 'pnpm/bin/pnpm.cjs')
  write(root, 'pnpm/package.json', '{"name":"pnpm","version":"11.28.5"}')
  write(root, 'pnpm/bin/pnpm.cjs', '')
  config.test.browser = 'chromium'
  config.test.timeoutMs = 1234
  write(root, 'scripts/config/local.json', JSON.stringify(config))
  cpSync(join(repoRoot, 'scripts/config/schema.json'), join(root, 'scripts/config/schema.json'))
  return root
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

interface Report {
  ok: boolean
  runDir: string
  steps: Array<{ name: string; ok?: boolean; exitCode?: number; detail?: string; error?: string }>
}

function report(root: string, kind: 'ci' | 'l5'): Report {
  const latest = JSON.parse(readFileSync(join(root, '.tmp', kind, 'last-report.json'), 'utf8')) as Report
  const inside = relative(join(root, '.tmp', kind), latest.runDir)
  assert.ok(inside && !inside.startsWith('..') && !inside.includes(':'))
  assert.deepEqual(JSON.parse(readFileSync(join(latest.runDir, 'report.json'), 'utf8')), latest)
  return latest
}

for (const failure of ['none', 'exit', 'throw', 'missing', 'partial', 'skip'] as const) {
  it(`L3 local CI: ${failure} preserves stage order, fail-fast and reports`, () => {
    const root = fixture()
    try {
      for (const [file, fn, name] of [
        ['build', 'runBuild', 'type-check'], ['test', 'runTest', 'l1-l3'],
        ['l4', 'runL4', 'l4'], ['l5', 'runL5', 'l5'],
      ]) {
        write(root, `scripts/.build/commands/${file}.js`, `
          import { appendFileSync } from 'node:fs';
          export async function ${fn}(options, context, onReport) {
            appendFileSync(process.env.TEST_TRACE, JSON.stringify({name: '${name}', options}) + '\\n');
            ${failure === 'exit' && name === 'l1-l3' ? 'return 7;' : ''}
            ${failure === 'throw' && name === 'l4' ? "throw new Error('failed http://127.0.0.1/?token=secret-test-token');" : ''}
            if(onReport) {
              const {requiredTestSteps}=await import('../core/test-run.js');
              const fs=await import('node:fs'),path=await import('node:path');
              const runDir=path.join(context.root,'.tmp','${name}','stub');fs.mkdirSync(runDir,{recursive:true});
              const report={version:1,kind:'${name}',ok:true,runDir,startedAt:new Date().toISOString(),cleanup:'retained --keep',steps:requiredTestSteps['${name}'].map(name=>({name,ok:true}))};
              fs.writeFileSync(path.join(runDir,'report.json'),JSON.stringify(report));onReport(report);
            }
            return 0;
          }
        `)
      }
      write(root, 'scripts/.build/commands/test-env.js', `
        import {writeFileSync,mkdirSync} from 'node:fs'; import {join} from 'node:path';
        import {repoRoot} from '../core/repo.js'; import {environmentIds} from '../core/environment-results.js';
        export async function runTestEnv(suite,keep,pnpm,only,onReport) {
          const root=join(repoRoot,'.tmp','env');mkdirSync(root,{recursive:true});
          const ids=environmentIds('all');
          const results=ids.map(id=>({id,status:'pass',evidence:id+'.json'}));
          for(const id of ids)writeFileSync(join(root,id+'.json'),JSON.stringify({id,passed:true,cleanup:'retained --keep'}));
          ${failure === 'partial' ? 'results.pop();' : ''}
          ${failure === 'skip' ? "results[0].status='skip';" : ''}
          const path=join(root,'report.json');writeFileSync(path,JSON.stringify({status:'passed',started:new Date().toISOString(),results}));
          ${failure === 'missing' ? '' : 'onReport(path);'}
          return 0;
        }
      `)
      write(root, 'entry.mjs', `
        import { runCi } from './scripts/.build/commands/ci.js';
        process.exitCode = await runCi({ keep: true${failure === 'none' ? '' : ', timeoutMs: 1234'} });
      `)
      const result = runToFiles(process.execPath, [join(root, 'entry.mjs')], {
        env: { ...process.env, TEST_TRACE: join(root, 'trace.jsonl') }, timeoutMs: 10_000,
        stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log'),
      })
      assert.equal(result.status, failure === 'none' ? 0 : failure === 'exit' ? 7 : 1, result.stderr)
      const latest = report(root, 'ci')
      const names = ['environment', 'type-check', 'l1-l3', 'l4', 'l5'].slice(0, failure === 'none' ? 5 : failure === 'exit' ? 3 : failure === 'throw' ? 4 : 1)
      assert.equal(latest.ok, failure === 'none')
      assert.deepEqual(latest.steps.map(step => step.name), names)
      const calls = (existsSync(join(root, 'trace.jsonl')) ? readFileSync(join(root, 'trace.jsonl'), 'utf8').trim() : '').split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { name: string; options: Record<string, unknown> })
      assert.deepEqual(calls.map(call => call.name), names.slice(1), 'later stages must not start after a failure')
      if (calls.length) assert.deepEqual(calls[0]?.options, { check: true })
      if (calls.length > 1) assert.deepEqual(calls[1]?.options, { kinds: [], build: true })
      if (failure === 'none') {
        assert.deepEqual(calls[2]?.options, { keep: true, timeoutMs: 1234, skipTarball: false })
        assert.deepEqual(calls[3]?.options, { keep: true, timeoutMs: 1234 })
      }
      if (failure === 'throw') {
        assert.match(latest.steps.at(-1)?.error ?? '', /\[redacted\]/)
        assert.ok(!JSON.stringify(latest).includes('secret-test-token'))
        assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-test-token'))
      }
    } finally { removeDir(root) }
  })
}

for (const phase of ['build', 'compile-browser', 'prerequisites', 'cleanup', 'success'] as const) {
  it(`L3 L5: ${phase} writes an accurate per-run and latest report`, () => {
    const root = fixture()
    try {
      write(root, 'scripts/.build/commands/build.js', `export async function runBuild() { return ${phase === 'build' ? 7 : 0}; }`)
      write(root, 'node_modules/typescript/bin/tsc', `process.exit(${phase === 'compile-browser' ? 9 : 0})`)
      // Browser/DSH integration is covered by L5 itself. Here only advance the
      // real orchestrator to cleanup without creating servers or browsers.
      write(root, 'scripts/.build/core/web-harness.js', `
        import { mkdirSync } from 'node:fs';
        export function childEnv() { return {}; }
        export function ensurePnpmShim(context) { mkdirSync(context.home, {recursive: true}); }
        export async function initProfile() {}
        export function runDsh() {}
        export async function serveAndCheck() { return 'simulated browser'; }
        export function redactLaunchTokens(text) { return text; }
      `)
      if (phase !== 'prerequisites') {
        write(root, 'package.json', JSON.stringify({ type: 'module', devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } }))
        write(root, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', bin: { dsh: './cli.cjs' } }))
        write(root, 'node_modules/@deepseek-ai/dsh/cli.cjs', '')
      }
      write(root, 'entry.mjs', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        ${phase === 'cleanup' ? `
          const original = fs.rmdirSync;
          fs.rmdirSync = (path, options) => {
            if (String(path).endsWith('dsh-home')) throw new Error('injected cleanup failure');
            return original(path, options);
          };
          syncBuiltinESMExports();
        ` : ''}
        const { runL5 } = await import('./scripts/.build/commands/l5.js');
        process.exitCode = await runL5({ keep: false, timeoutMs: 1000 });
      `)
      const result = runToFiles(process.execPath, [join(root, 'entry.mjs')], {
        env: { ...process.env, DSH_CLI: phase === 'prerequisites' ? join(root, 'missing-dsh') : process.execPath },
        timeoutMs: 10_000, stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log'),
      })
      assert.equal(result.status, phase === 'success' ? 0 : 1, result.stderr)
      const latest = report(root, 'l5')
      assert.equal(latest.ok, phase === 'success')
      if (phase === 'success') {
        assert.deepEqual(latest.steps.map(step => step.name), ['context', 'build', 'compile-browser', 'prerequisites', 'profile-init', 'baseline', 'install-fixture', 'fixture', 'cleanup'])
        assert.equal(existsSync(join(latest.runDir, 'dsh-home')), false)
      } else {
        assert.equal(latest.steps.at(-1)?.name, phase === 'prerequisites' ? 'context' : phase)
        assert.equal(latest.steps.at(-1)?.ok, false)
        if (phase === 'cleanup') assert.match(latest.steps.at(-1)?.detail ?? '', /injected cleanup failure/)
      }
    } finally { removeDir(root) }
  })
}

it('L3 L5: a successful process must still supply every successful browser check', () => {
  const root = makeTempDir('browser-results')
  try {
    assert.throws(() => assertBrowserResults(root, 'baseline'), /ENOENT/)
    const good = ['slot-interaction-theme-locale-reload', 'notification-en', 'notification-zh', 'notification-denied']
      .map(name => ({ name, ok: true }))
    for (const invalid of [[], good.slice(1), [...good, good[0]], good.map((entry, i) => i === 1 ? { ...entry, ok: false } : entry), [good[0], good[1], good[1], good[3]]]) {
      write(root, 'results.json', JSON.stringify(invalid))
      assert.throws(() => assertBrowserResults(root, 'fixture'), /incomplete or failed/)
    }
    write(root, 'results.json', JSON.stringify(good))
    assert.doesNotThrow(() => assertBrowserResults(root, 'fixture'))
    write(root, 'results.json', JSON.stringify([{ name: 'no-custom-plugins', ok: true }]))
    assert.doesNotThrow(() => assertBrowserResults(root, 'baseline'))
  } finally { removeDir(root) }
})
