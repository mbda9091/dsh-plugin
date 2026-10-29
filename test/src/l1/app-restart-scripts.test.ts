import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname } from 'node:path'
import { buildHelperScript, buildLauncherScript, vbsString } from '@local/app-restart'

describe('L1 app-restart: VBScript literals', () => {
  it('doubles embedded quotes and leaves backslashes alone', () => {
    assert.equal(vbsString('plain'), '"plain"')
    assert.equal(vbsString('a"b'), '"a""b"')
    assert.equal(vbsString('C:\\Temp\\x.vbs'), '"C:\\Temp\\x.vbs"')
    assert.equal(vbsString('中文 "x"'), '"中文 ""x"""')
  })
})

describe('L1 app-restart: launcher script', () => {
  const helper = 'C:\\Temp\\dsh-restart-1-helper.vbs'
  const script = buildLauncherScript(helper)

  it('uses CRLF line endings only', () => {
    assert.ok(script.includes('\r\n'))
    assert.ok(!/(?<!\r)\n/.test(script))
  })

  it('starts with Option Explicit', () => {
    assert.equal(script.split('\r\n')[0], 'Option Explicit')
  })

  it('creates the helper through WMI', () => {
    assert.ok(script.includes('Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")'))
    assert.ok(script.includes('Set proc = svc.Get("Win32_Process")'))
    assert.ok(script.includes('rc = proc.Create(cmd, Null, Null, pid)'))
  })

  it('passes the helper path as one quoted VBScript literal', () => {
    assert.ok(script.includes(`& ${vbsString(helper)} &`))
  })

  it('escapes a helper path that contains a quote', () => {
    const tricky = 'C:\\Temp\\a"b.vbs'
    const escaped = buildLauncherScript(tricky)
    assert.ok(escaped.includes(`& ${vbsString(tricky)} &`))
    assert.ok(vbsString(tricky).includes('""'))
  })

  it('is deterministic', () => {
    assert.equal(buildLauncherScript(helper), script)
  })
})

describe('L1 app-restart: helper script', () => {
  const launcher = 'C:\\Temp\\dsh-restart-1-launch.vbs'
  const script = buildHelperScript(launcher)

  it('uses CRLF line endings only', () => {
    assert.ok(script.includes('\r\n'))
    assert.ok(!/(?<!\r)\n/.test(script))
  })

  it('records the current executable, directory and PIDs', () => {
    assert.ok(script.includes(`exe = ${vbsString(process.execPath)}`))
    assert.ok(script.includes(`dir = ${vbsString(dirname(process.execPath))}`))
    assert.ok(script.includes(`shellPid = ${process.ppid}`))
    assert.ok(script.includes(`hostPid = ${process.pid}`))
  })

  it('stops both the shell and the Host, then relaunches with retries', () => {
    assert.ok(script.includes('Call Kill(shellPid)'))
    assert.ok(script.includes('Call Kill(hostPid)'))
    assert.ok(script.includes('For i = 1 To 4'))
    assert.ok(script.includes('sh.Run Chr(34) & exe & Chr(34), 1, False'))
    assert.ok(script.includes('If AppRunning() Then'))
  })

  it('deletes itself and the launcher', () => {
    assert.ok(script.includes('fso.DeleteFile WScript.ScriptFullName, True'))
    assert.ok(script.includes(`fso.DeleteFile ${vbsString(launcher)}, True`))
  })

  it('writes progress to a log under %TEMP%', () => {
    assert.ok(script.includes('logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\\dsh-restart.log"'))
  })

  it('launches the app through the GUI script host, not a console', () => {
    assert.ok(script.includes('Set sh = CreateObject("WScript.Shell")'))
    assert.ok(!script.includes('powershell.exe'))
    assert.ok(!script.includes('cmd.exe'))
  })

  it('is deterministic', () => {
    assert.equal(buildHelperScript(launcher), script)
  })
})
