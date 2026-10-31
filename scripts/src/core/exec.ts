import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Child-process helpers that never use pipes.
 *
 * DSH's sandbox denies piped child stdio (`EPERM`), so every child writes to
 * real files and the parent reads them back. The same trick keeps the full
 * transcript for failed L4 steps.
 */

export interface OutputPaths {
  readonly stdoutPath: string
  readonly stderrPath: string
}

export interface RunOptions extends OutputPaths {
  readonly ownProcessTree?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly timeoutMs?: number | undefined
  /** Pass argv verbatim (Windows `cmd.exe` fallback only). */
  readonly verbatim?: boolean | undefined
}

export interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function prepare(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

/** Run a command to completion, capturing stdout/stderr in files. */
export function runToFiles(command: string, args: readonly string[], options: RunOptions): RunResult {
  prepare(options.stdoutPath)
  prepare(options.stderrPath)
  const outFd = openSync(options.stdoutPath, 'w')
  const errFd = openSync(options.stderrPath, 'w')
  try {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', outFd, errFd],
      timeout: options.timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim === true,
    })
    if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
      throw new Error(`cannot run ${command}: ${result.error.message}`)
    }
    return {
      status: result.status,
      signal: result.signal,
      stdout: readOrEmpty(options.stdoutPath),
      stderr: readOrEmpty(options.stderrPath),
      timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

export interface StartedProcess extends OutputPaths {
  readonly child: ChildProcess
  readonly spawnError: () => Error | undefined
}

/** Start a long-running command with stdout/stderr redirected to files. */
export function startToFiles(command: string, args: readonly string[], options: RunOptions): StartedProcess {
  prepare(options.stdoutPath)
  prepare(options.stderrPath)
  const outFd = openSync(options.stdoutPath, 'w')
  const errFd = openSync(options.stderrPath, 'w')
  try {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim === true,
      detached: options.ownProcessTree === true && process.platform !== 'win32',
    })
    let error: Error | undefined
    child.once('error', (cause) => { error = cause })
    return { child, spawnError: () => error, stdoutPath: options.stdoutPath, stderrPath: options.stderrPath }
  } finally {
    // The child holds duplicated handles; the parent no longer needs these.
    closeSync(outFd)
    closeSync(errFd)
  }
}

/** Async file capture keeps signal handling live while DSH/pnpm/browser work. */
export async function runToFilesAsync(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  options.signal?.throwIfAborted()
  const started = startToFiles(command, args, { ...options, ownProcessTree: true })
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  let timedOut = false
  try {
    while (started.child.exitCode === null && started.child.signalCode === null) {
      options.signal?.throwIfAborted()
      if (started.spawnError()) throw started.spawnError()
      if (Date.now() >= deadline) { timedOut = true; break }
      await sleep(50)
    }
  } finally { await stopOwnedTree(started.child) }
  options.signal?.throwIfAborted()
  return { status: started.child.exitCode, signal: started.child.signalCode, timedOut,
    stdout: readOrEmpty(options.stdoutPath), stderr: readOrEmpty(options.stderrPath) }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Last `lines` lines of a file, for failure messages. */
export function tail(path: string, lines = 20): string {
  if (!existsSync(path)) return ''
  const content = readOrEmpty(path).trimEnd()
  if (content === '') return ''
  return content.split(/\r?\n/).slice(-lines).join('\n')
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`process ${child.pid ?? '?'} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    const done = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', done)
      child.off('close', done)
    }
    child.once('exit', done)
    child.once('close', done)
  })
}

/**
 * Stop a child and wait for it to exit. On Windows `kill()` terminates the
 * process directly; the timeout is a backstop for a wedged shutdown.
 */
export async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.pid === undefined) return // spawn failed
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill()
  } catch {
    // Already gone.
  }
  try {
    await waitForExit(child, timeoutMs)
  } catch {
    try {
      if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL')
    } catch {
      // Nothing left to kill.
    }
    await waitForExit(child, timeoutMs)
  }
}

/** Only for children spawned with ownProcessTree; never use recorded/ambient PIDs. */
export async function stopOwnedTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups; /T covers this live child's pnpm/browser descendants.
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    if (result.error) throw result.error
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 0) } catch { return }
      throw new Error('failed to stop owned test process tree')
    }
    await waitForExit(child, 10_000)
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await stopChild(child)
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}

export interface ServerWaitOptions {
  readonly signal?: AbortSignal | undefined
  readonly urlPattern: RegExp
  readonly timeoutMs: number
  readonly pollMs?: number | undefined
}

/**
 * Poll the captured stdout until the command prints its URL. Fails fast when
 * the child exits or the timeout expires, including the captured stderr.
 */
export async function waitForServerUrl(started: StartedProcess, options: ServerWaitOptions): Promise<string> {
  const pollMs = options.pollMs ?? 200
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    const error = started.spawnError()
    if (error !== undefined) throw new Error(`cannot start server: ${error.message}`)
    if (existsSync(started.stdoutPath)) {
      const match = options.urlPattern.exec(readOrEmpty(started.stdoutPath))
      if (match !== null) {
        const url = match[1]
        if (url !== undefined && url !== '') return url
      }
    }
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      throw new Error(
        `server exited before printing a URL (code=${started.child.exitCode}, signal=${started.child.signalCode})\n` +
          `stderr:\n${tail(started.stderrPath, 20) || '(empty)'}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `server did not print a URL within ${options.timeoutMs}ms\n` +
          `stdout:\n${tail(started.stdoutPath, 20) || '(empty)'}\n` +
          `stderr:\n${tail(started.stderrPath, 20) || '(empty)'}`,
      )
    }
    await sleep(pollMs)
  }
}

/**
 * GET a page the way a browser would for DSH's auth handshake.
 *
 * `dsh web` answers `/?token=...` with a 303 that sets an HttpOnly auth cookie
 * and redirects to `./`; the redirect target is only reachable with that
 * cookie. Node's fetch has no cookie jar, so this follows the one redirect by
 * copying the Set-Cookie value.
 */
export async function fetchPage(url: string, timeoutMs = 10_000): Promise<{ status: number; html: string }> {
  const signal = AbortSignal.timeout(timeoutMs)
  const first = await fetch(url, { redirect: 'manual', signal })
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    const getSetCookie = first.headers.getSetCookie
    const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(first.headers) : []
    const cookie = cookies.map((entry) => entry.split(';')[0] ?? '').filter((entry) => entry !== '').join('; ')
    await first.text()
    const nextUrl = location === null ? url : new URL(location, url).href
    const second = await fetch(nextUrl, { headers: cookie === '' ? undefined : { cookie }, signal })
    return { status: second.status, html: await second.text() }
  }
  return { status: first.status, html: await first.text() }
}

/** GET a URL until it answers or the timeout expires. Returns the HTTP status. */
export async function waitForHttp(url: string, timeoutMs: number, pollMs = 300, signal?: AbortSignal): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    signal?.throwIfAborted()
    try {
      const { status } = await fetchPage(url, Math.max(1, Math.min(1000, deadline - Date.now())))
      return status
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(`no HTTP response from ${url} within ${timeoutMs}ms: ${message}`)
    }
    await sleep(pollMs)
  }
}

/** Wait until a URL no longer accepts connections (used to prove the port closed). */
export async function waitForHttpClosed(url: string, timeoutMs: number, pollMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
      await response.body?.cancel()
    } catch (error) {
      // A hung server still owns its port; a request timeout is not proof of exit.
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined
      if (cause?.code === 'ECONNREFUSED') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`${url} still accepts connections after ${timeoutMs}ms`)
    await sleep(pollMs)
  }
}
