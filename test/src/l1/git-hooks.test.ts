import assert from 'node:assert/strict'
import { it } from 'node:test'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupGitHooks } from '../../../scripts/.build/git-hooks.js'
import { runToFiles } from '../../../scripts/.build/core/exec.js'
import { startEnvironmentCleanup, finishEnvironmentCleanup, withTestWorkLock } from '../../../scripts/.build/core/test-storage.js'
import { makeTempDir, removeDir, repoRoot } from '../harness/tmp.js'

function fixture() {
  const root = makeTempDir("git-hooks 中文 space-'"), remote = join(root, 'remote.git')
  let calls = 0
  const git = (args: string[], status = 0) => {
    const result = runToFiles('git', args, { cwd: root, timeoutMs: 30000,
      stdoutPath: join(root, '.tmp', `git-${calls++}.out`), stderrPath: join(root, '.tmp', `git-${calls}.err`) })
    assert.equal(result.status, status, result.stderr + result.stdout)
    return result
  }
  git(['init', '-b', 'main']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture'])
  writeFileSync(join(root, '.gitignore'), '.tmp/\nremote.git/\nnode_modules/\nscripts/\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  git(['add', '.gitignore', 'package.json']); git(['commit', '-m', 'fixture'])
  git(['init', '--bare', remote]); git(['remote', 'add', 'fixture', remote])
  cpSync(join(repoRoot, 'scripts/.build'), join(root, 'scripts/.build'), { recursive: true })
  for (const name of ['git-hooks.mjs', 'dev.mjs', 'launch.mjs']) cpSync(join(repoRoot, 'scripts', name), join(root, 'scripts', name))
  // Exercise the real thin launcher and compiled CLI without compiling the
  // entire project inside every tiny Git fixture. Fresh-install QA uses real tsc.
  const compiler = join(root, 'node_modules/typescript/bin/tsc')
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true }); writeFileSync(compiler, '')
  const data = (name = 'one', status: 'passed' | 'failed' = 'passed', days = 0, keep = false) => {
    const run = join(root, '.tmp/environment-tests', `run-${name}`), home = join(run, 'repo 中文 space-one/.formal-home')
    mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'temporary-data'), 'disposable')
    writeFileSync(join(run, 'report.json'), '{"evidence":"unchanged"}')
    startEnvironmentCleanup(root, run, keep); finishEnvironmentCleanup(root, run, status, true)
    if (days) {
      const file = join(run, 'cleanup-state.json'), state = JSON.parse(readFileSync(file, 'utf8'))
      state.started = state.ended = new Date(Date.now() - days * 86400000).toISOString()
      writeFileSync(file, JSON.stringify(state)) // Synthetic age sample, not a real report.
    }
    return { run, home }
  }
  return { root, remote, compiler, git, data }
}

it('Git hooks: setup is idempotent, preserves hooksPath, native security hook and legacy hook stdin', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'custom-hooks'))
    writeFileSync(join(f.root, 'custom-hooks/pre-push'), '#!/bin/sh\ncat > .tmp/legacy-refs\nprintf "%s\\n" "$1" > .tmp/legacy-remote\n', { mode: 0o755 })
    writeFileSync(join(f.root, 'custom-hooks/native-reader'), '#!/bin/sh\ncat > .tmp/native-refs\n', { mode: 0o755 })
    f.git(['config', 'core.hooksPath', 'custom-hooks'])
    f.git(['config', 'hook.existing-security.command', './custom-hooks/native-reader'])
    f.git(['config', 'hook.existing-security.event', 'pre-push'])
    setupGitHooks(f.root); setupGitHooks(f.root)
    const oldEntry = runToFiles(process.execPath, ['scripts/dev.mjs', 'push'], { cwd: f.root, timeoutMs: 15000,
      stdoutPath: join(f.root, '.tmp/removed-push.out'), stderrPath: join(f.root, '.tmp/removed-push.err') })
    assert.equal(oldEntry.status, 1); assert.match(oldEntry.stderr, /[Uu]nknown command.*push/)
    assert.equal(f.git(['config', 'core.hooksPath']).stdout.trim(), 'custom-hooks')
    assert.equal(f.git(['config', '--get-all', 'hook.repo-test-cleanup.event']).stdout.trim(), 'pre-push')
    const sample = f.data()
    f.git(['push', 'fixture', 'main'])
    assert.equal(existsSync(sample.home), false)
    assert.equal(readFileSync(join(sample.run, 'report.json'), 'utf8'), '{"evidence":"unchanged"}')
    assert.match(readFileSync(join(f.root, '.tmp/legacy-refs'), 'utf8'), /refs\/heads\/main/)
    assert.match(readFileSync(join(f.root, '.tmp/native-refs'), 'utf8'), /refs\/heads\/main/)
    assert.equal(readFileSync(join(f.root, '.tmp/legacy-remote'), 'utf8').trim(), 'fixture')
    const command = f.git(['config', 'hook.repo-test-cleanup.command']).stdout.trim()
    f.git(['config', 'hook.repo-test-cleanup.command', "'/old/node' scripts/git-hooks.mjs pre-push || :"])
    setupGitHooks(f.root)
    assert.equal(f.git(['config', 'hook.repo-test-cleanup.command']).stdout.trim(), command)
  } finally { removeDir(f.root) }
})

it('Git hooks: dry-run, rejected and up-to-date pushes use the same pre-push cleanup', () => {
  const f = fixture()
  try {
    setupGitHooks(f.root)
    const dry = f.data('dry', 'failed', 8), fresh = f.data('fresh', 'failed'), kept = f.data('keep', 'failed', 8, true)
    f.git(['push', '--dry-run', 'fixture', 'main'])
    assert.equal(existsSync(dry.home), false); assert.ok(existsSync(fresh.home)); assert.ok(existsSync(kept.home))
    assert.equal(existsSync(join(f.remote, 'refs/heads/main')), false)
    writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const rejected = f.data('rejected')
    f.git(['push', 'fixture', 'main'], 1)
    assert.equal(existsSync(rejected.home), false)
    writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 0\n')
    f.git(['push', 'fixture', 'main'])
    const unchanged = f.data('unchanged')
    f.git(['push', 'fixture', 'main'])
    assert.equal(existsSync(unchanged.home), false)
  } finally { removeDir(f.root) }
})

it('Git hooks: active test lock skips cleanup without blocking push', async () => {
  const f = fixture()
  try {
    setupGitHooks(f.root); const sample = f.data()
    writeFileSync(f.compiler, 'throw new Error("pre-push must not rebuild shared output")')
    await withTestWorkLock(f.root, 'test', async () => {
      const result = f.git(['push', 'fixture', 'main'])
      assert.match(result.stdout, /test cleanup: skipped/); assert.ok(existsSync(sample.home))
    })
  } finally { removeDir(f.root) }
})

it('Git hooks: cleanup errors and missing prepared output or Node never block push', () => {
  const f = fixture()
  try {
    setupGitHooks(f.root); const sample = f.data()
    // Writing the cleanup summary fails even on privileged test machines.
    mkdirSync(join(f.root, '.tmp/environment-tests/last-cleanup.json'))
    assert.match(f.git(['push', 'fixture', 'main']).stderr, /cleanup failed; push may continue/)
    renameSync(join(f.root, 'node_modules'), join(f.root, 'missing-dependencies'))
    renameSync(join(f.root, 'scripts/.build'), join(f.root, 'scripts/missing-build'))
    const missing = f.data('missing')
    assert.match(f.git(['push', 'fixture', 'main']).stderr, /test cleanup unavailable; push may continue/)
    assert.ok(existsSync(missing.home))
    f.git(['config', 'hook.repo-test-cleanup.command', "'/missing-node-for-hook' scripts/git-hooks.mjs pre-push || :"])
    assert.match(f.git(['push', 'fixture', 'main']).stderr, /missing-node-for-hook/)
    assert.ok(existsSync(join(f.remote, 'refs/heads/main')))
    assert.equal(existsSync(sample.home), false)
  } finally { removeDir(f.root) }
})

it('Git hooks: a full exported-source postinstall stops before touching parent configuration or security setup', () => {
  const f = fixture()
  try {
    const exported = join(f.root, 'exported'); mkdirSync(exported)
    cpSync(join(f.root, 'scripts'), join(exported, 'scripts'), { recursive: true })
    cpSync(join(f.root, 'node_modules'), join(exported, 'node_modules'), { recursive: true })
    cpSync(join(repoRoot, 'package.json'), join(exported, 'package.json'))
    mkdirSync(join(exported, '.security'))
    writeFileSync(join(exported, '.security/setup.sh'), '#!/bin/sh\nprintf touched > ../security-was-run\n', { mode: 0o755 })
    const config = readFileSync(join(f.root, '.git/config'))
    const postinstall = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts.postinstall
    const result = runToFiles('sh', ['-c', postinstall], { cwd: exported, timeoutMs: 15000,
      stdoutPath: join(f.root, '.tmp/export.out'), stderrPath: join(f.root, '.tmp/export.err') })
    assert.notEqual(result.status, 0); assert.match(result.stderr, /requires the repository root/)
    assert.equal(existsSync(join(f.root, 'security-was-run')), false)
    assert.deepEqual(readFileSync(join(f.root, '.git/config')), config)
  } finally { removeDir(f.root) }
})

it('Git hooks: a security setup failure still fails the complete postinstall', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, '.security'))
    writeFileSync(join(f.root, '.security/setup.sh'), '#!/bin/sh\nexit 23\n', { mode: 0o755 })
    const postinstall = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts.postinstall
    const result = runToFiles('sh', ['-c', postinstall], { cwd: f.root, timeoutMs: 15000,
      stdoutPath: join(f.root, '.tmp/postinstall.out'), stderrPath: join(f.root, '.tmp/postinstall.err') })
    assert.equal(result.status, 23)
    assert.equal(f.git(['config', '--get-all', 'hook.repo-test-cleanup.event']).stdout.trim(), 'pre-push')
  } finally { removeDir(f.root) }
})

it('Git hooks: a linked worktree push only cleans the initiating worktree', () => {
  const f = fixture()
  try {
    const other = join(f.root, 'linked-worktree')
    f.git(['worktree', 'add', '-b', 'linked', other])
    cpSync(join(f.root, 'scripts'), join(other, 'scripts'), { recursive: true })
    setupGitHooks(f.root)
    const original = f.data()
    const run = join(other, '.tmp/environment-tests/run-linked'), home = join(run, 'repo 中文 space-one/.formal-home')
    mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'temporary-data'), 'disposable')
    startEnvironmentCleanup(other, run, false); finishEnvironmentCleanup(other, run, 'passed', true)
    const result = runToFiles('git', ['push', 'fixture', 'linked'], { cwd: other, timeoutMs: 15000,
      stdoutPath: join(f.root, '.tmp/worktree.out'), stderrPath: join(f.root, '.tmp/worktree.err') })
    assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(home), false); assert.ok(existsSync(original.home))
    assert.equal(f.git(['config', '--get-all', 'hook.repo-test-cleanup.event']).stdout.trim(), 'pre-push')
  } finally { removeDir(f.root) }
})

it('Git hooks: an existing rejecting hook still blocks push', () => {
  const f = fixture()
  try {
    f.git(['config', 'hook.existing-security.command', 'exit 1']); f.git(['config', 'hook.existing-security.event', 'pre-push'])
    setupGitHooks(f.root)
    f.git(['push', 'fixture', 'main'], 1)
    assert.equal(existsSync(join(f.remote, 'refs/heads/main')), false)
  } finally { removeDir(f.root) }
})

it('Git hooks: conflicts and exported source directories never configure an enclosing repository', () => {
  const f = fixture()
  try {
    const exported = join(f.root, 'exported'); mkdirSync(exported)
    assert.throws(() => setupGitHooks(exported), /requires the repository root/)
    assert.equal(f.git(['config', '--get', 'hook.repo-test-cleanup.event'], 1).stdout, '')
    f.git(['config', 'hook.repo-test-cleanup.command', 'custom-command'])
    assert.throws(() => setupGitHooks(f.root), /command was modified/)
    assert.equal(f.git(['config', 'hook.repo-test-cleanup.command']).stdout.trim(), 'custom-command')
    f.git(['config', '--unset', 'hook.repo-test-cleanup.command'])
    f.git(['config', 'hook.pre-push.enabled', 'false'])
    assert.throws(() => setupGitHooks(f.root), /is disabled/)
    assert.equal(f.git(['config', '--get', 'hook.repo-test-cleanup.command'], 1).stdout, '')
  } finally { removeDir(f.root) }
})
