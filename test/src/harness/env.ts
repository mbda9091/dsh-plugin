/**
 * Process-level fakes for target detection and environment lookups.
 *
 * `assertTarget` reads `process.versions.electron` and the current platform
 * directly, so tests that need a surface other than `headless` must adjust the
 * process for the duration of one assertion and restore it afterwards.
 */

interface MutableVersions {
  electron?: string
}

/** Synchronous platform override; always restore the original descriptor. */
export function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return body()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function versions(): MutableVersions {
  return process.versions as NodeJS.ProcessVersions & MutableVersions
}

/** Run `body` with `process.versions.electron` set (desktop surface). */
export function withElectron<T>(body: () => T): T {
  const target = versions()
  const had = Object.prototype.hasOwnProperty.call(target, 'electron')
  const previous = target.electron
  target.electron = 'test-electron'
  try {
    return body()
  } finally {
    if (had && previous !== undefined) target.electron = previous
    else delete target.electron
  }
}

/** Run `body` with an environment variable set (`undefined` removes it). */
export async function withEnv<T>(name: string, value: string | undefined, body: () => Promise<T> | T): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, name)
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await body()
  } finally {
    if (had && previous !== undefined) process.env[name] = previous
    else delete process.env[name]
  }
}
