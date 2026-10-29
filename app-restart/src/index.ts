import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { assertTarget } from './targets.js'

// Re-exported so the unit tests can exercise the compatibility decision and the
// environment detection without loading a full Host. Runtime behaviour is
// unchanged: `apply` still calls `assertTarget`.
export { detectEnvironment, evaluateTarget } from './targets.js'

export const name = 'app-restart'

/** The command registry is provided by the base bundle's `commands` row. */
export const inject = ['commands']

/**
 * The slice of `@deepseek-ai/dsh-commands` used here. The package is not a
 * dependency of this plugin (it is part of the Host); these shapes mirror its
 * public command contract: a direct UI handler returning a settlement.
 */
export interface CommandResult {
  kind: 'success'
  text?: string
}

export interface CommandDefinition {
  name: string
  description: string
  handler: () => CommandResult
}

export interface CommandsService {
  register(definition: CommandDefinition): unknown
}

/**
 * Register `/restart`.
 *
 * The Electron shell owns `app.relaunch()`, which a Host plugin cannot call.
 * Instead a helper outside the Host's job stops the shell and this Host, then
 * launches the same executable again.
 */
export function apply(ctx: Context): void {
  assertTarget(ctx, name)

  const commands = (ctx as unknown as { commands?: CommandsService }).commands
  if (commands === undefined) {
    console.warn('[app-restart] the commands service is unavailable')
    return
  }

  registerRestartCommand(commands)
}

/**
 * Register `/restart` against a command registry.
 *
 * Separated from {@link apply} so tests can assert the registration and the
 * handler's single invocation without spawning wscript. Production always uses
 * the default {@link restart}.
 *
 * @param commands - the Host command registry.
 * @param run - the restart side effect; defaults to the wscript launcher.
 */
export function registerRestartCommand(commands: CommandsService, run: () => void = restart): void {
  commands.register({
    name: 'restart',
    description: '重启 DeepSeek Harness（应用与 Host），当前回合会被中断。',
    handler: () => {
      run()
      return { kind: 'success', text: '正在重启 DeepSeek Harness…' }
    },
  })
}

/**
 * Write two scripts and launch the first one through wscript.
 *
 * Everything runs under wscript/VBScript, a GUI-subsystem script host: unlike
 * PowerShell it never creates a console window. The launcher only uses WMI to
 * create the helper; a WMI-created process is outside the Electron shell's job
 * object, so the helper survives the shell's exit. The helper in turn launches
 * the app with `WScript.Shell`, which also has no console to inherit.
 */
function restart(): void {
  const helperPath = join(tmpdir(), `dsh-restart-${process.pid}-helper.vbs`)
  const launcherPath = join(tmpdir(), `dsh-restart-${process.pid}-launch.vbs`)
  try {
    writeFileSync(helperPath, buildHelperScript(launcherPath), 'utf8')
    writeFileSync(launcherPath, buildLauncherScript(helperPath), 'utf8')
    const child = spawn(resolveWscript(), ['//B', '//Nologo', launcherPath], {
      windowsHide: true,
      stdio: 'ignore',
    })
    child.on('error', (error: Error) => {
      console.warn('[app-restart] cannot start the restart helper:', error)
    })
    child.unref()
  } catch (error) {
    console.warn('[app-restart] cannot restart:', error)
  }
}

/** The launcher: ask WMI to create the real helper outside the Host's job. */
export function buildLauncherScript(helperPath: string): string {
  return [
    'Option Explicit',
    'Dim svc, proc, cmd, pid, rc',
    'Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    'Set proc = svc.Get("Win32_Process")',
    `cmd = "wscript.exe //B //Nologo " & Chr(34) & ${vbsString(helperPath)} & Chr(34)`,
    'rc = proc.Create(cmd, Null, Null, pid)',
  ].join('\r\n')
}

/**
 * The helper: stop the shell and this Host, wait, then relaunch the app and
 * retry if it does not come up. Both stopping and checking use WMI, and the
 * app is started through `WScript.Shell` (no console), so nothing flashes and
 * no terminal outlives the restart. Progress goes to %TEMP%\dsh-restart.log.
 */
export function buildHelperScript(launcherPath: string): string {
  const executable = vbsString(process.execPath)
  const directory = vbsString(dirname(process.execPath))
  const shellPid = process.ppid
  const hostPid = process.pid
  return [
    'Option Explicit',
    'Dim sh, fso, logFile, exe, dir, shellPid, hostPid, i',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\\dsh-restart.log"',
    `exe = ${executable}`,
    `dir = ${directory}`,
    `shellPid = ${shellPid}`,
    `hostPid = ${hostPid}`,
    'sh.CurrentDirectory = dir',
    'Call Note("stop " & shellPid & "," & hostPid)',
    'WScript.Sleep 600',
    'Call Kill(shellPid)',
    'Call Kill(hostPid)',
    'WScript.Sleep 2000',
    'For i = 1 To 4',
    '  sh.Run Chr(34) & exe & Chr(34), 1, False',
    '  Call Note("launch " & i)',
    '  WScript.Sleep 2000',
    '  If AppRunning() Then',
    '    Call Note("started")',
    '    Exit For',
    '  End If',
    '  WScript.Sleep 1000',
    'Next',
    'On Error Resume Next',
    'fso.DeleteFile WScript.ScriptFullName, True',
    `fso.DeleteFile ${vbsString(launcherPath)}, True`,
    '',
    'Sub Note(msg)',
    '  On Error Resume Next',
    '  Dim f',
    '  Set f = fso.OpenTextFile(logFile, 8, True)',
    '  f.WriteLine Stamp() & " " & msg',
    '  f.Close',
    'End Sub',
    '',
    'Function Stamp()',
    '  Dim dtm, v, p, sign, off',
    '  Set dtm = CreateObject("WbemScripting.SWbemDateTime")',
    '  dtm.SetVarDate Now, True',
    '  v = dtm.Value',
    '  p = InStr(v, "+")',
    '  sign = "+"',
    '  If p = 0 Then',
    '    p = InStr(v, "-")',
    '    sign = "-"',
    '  End If',
    '  off = CInt(Mid(v, p + 1))',
    '  Stamp = Mid(v, 1, 4) & "-" & Mid(v, 5, 2) & "-" & Mid(v, 7, 2) & "T" & Mid(v, 9, 2) & ":" & Mid(v, 11, 2) & ":" & Mid(v, 13, 2) & "." & Mid(v, 16, 3) & sign & Pad(Int(off / 60)) & ":" & Pad(off Mod 60)',
    'End Function',
    '',
    'Function Pad(n)',
    '  Pad = Right("0" & n, 2)',
    'End Function',
    '',
    'Sub Kill(pid)',
    '  On Error Resume Next',
    '  Dim svc, list, p',
    '  Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    '  Set list = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)',
    '  For Each p In list',
    '    p.Terminate()',
    '  Next',
    'End Sub',
    '',
    'Function AppRunning()',
    '  On Error Resume Next',
    '  Dim svc, list',
    '  Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    `  Set list = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='DeepSeek Harness.exe'")`,
    '  AppRunning = (list.Count > 0)',
    'End Function',
  ].join('\r\n')
}

/** Escape one value as a VBScript string literal. */
export function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Resolve the GUI-subsystem script host (never creates a console). */
function resolveWscript(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const absolute = join(root, 'System32', 'wscript.exe')
  return existsSync(absolute) ? absolute : 'wscript.exe'
}
