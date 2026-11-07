import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'

/** Model DSH's restriction while still executing real fixture subprocesses. */
export function assertFileOnlyProbe<T>(action: () => T): T {
  const spawn = childProcess.spawnSync, mkdtemp = fs.mkdtempSync
  const directories: string[] = []
  let calls = 0
  const spawnMock = mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof spawn>) => {
    const options = args[2]
    assert.ok(Array.isArray(options?.stdio), 'discovery must explicitly select file stdio')
    for (const fd of options.stdio.slice(1)) {
      assert.equal(typeof fd, 'number', 'sandbox rejects piped stdout/stderr')
      assert.ok(fs.fstatSync(fd as number).isFile(), 'stdout/stderr must be regular files')
    }
    calls++
    return Reflect.apply(spawn, childProcess, args)
  })
  const execMock = mock.method(childProcess, 'execFileSync', () => {
    throw new Error('sandbox rejects execFileSync pipe capture')
  })
  const tempMock = mock.method(fs, 'mkdtempSync', (...args: Parameters<typeof mkdtemp>) => {
    const directory = Reflect.apply(mkdtemp, fs, args) as string
    directories.push(directory)
    return directory
  })
  syncBuiltinESMExports()
  try {
    const result = action()
    assert.ok(calls > 0, 'probe must execute a subprocess')
    return result
  } finally {
    spawnMock.mock.restore(); execMock.mock.restore(); tempMock.mock.restore()
    syncBuiltinESMExports()
    for (const directory of directories) assert.equal(fs.existsSync(directory), false, 'probe must clean temporary files')
  }
}
