/**
 * Desktop Windows toast + sound for the two moments that need the user back:
 * an approval request and a finished turn.
 *
 * The Host process is an ordinary Node process (the Desktop shell runs the
 * engine with ELECTRON_RUN_AS_NODE), so there is no Electron `Notification`
 * here. Windows toasts are shown through PowerShell's WinRT binding using the
 * Desktop app's AppUserModelID; when that path is unavailable the script falls
 * back to a tray balloon. The sound is played explicitly so it does not depend
 * on the toast's own audio being audible.
 *
 * The Web surface is a separate plugin (`notify-web`): the browser page owns
 * browser notifications and tab focus there. This package is the Desktop
 * adapter only.
 *
 * @module @local/desktop-notify
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { approvalContent, fallbackTranslate, turnEndContent } from '@local/notify-core'
import { createNotificationSource } from '@local/notify-host'
import { assertTarget } from './targets.js'

// Re-exported so the unit tests can exercise the compatibility decision and the
// environment detection without loading a full Host. Runtime behaviour is
// unchanged: `apply` still calls `assertTarget`.
export { detectEnvironment, evaluateTarget } from './targets.js'

/**
 * Plugin configuration, read from the loader row's `config`.
 *
 * The loader passes the YAML object through as-is; these optional fields are
 * merged over {@link DEFAULTS} in `apply`. Runtime validation is deliberately
 * absent: keep the row in the profile's `cordis.patch.yml` in sync with this
 * interface, and TypeScript checks every use inside the plugin.
 */
export interface Config {
  /** Notify when a tool asks the user to approve a wider permission. @default true */
  notifyOnApproval?: boolean
  /**
   * How long to wait for an automatic approval decision before showing the
   * approval notification. An allowlist decision arrives immediately and
   * cancels the pending notification. @default 300
   */
  approvalDelayMs?: number
  /** Notify when a turn finishes normally. @default true */
  notifyOnTurnEnd?: boolean
  /** Notify when a turn ends with an error. @default true */
  notifyOnTurnError?: boolean
  /** Play a notification sound together with the toast. @default true */
  sound?: boolean
  /** AppUserModelID of the Desktop shell; its Start-menu shortcut owns the toasts. @default 'com.deepseek.dsh' */
  appId?: string
  /** WAV played when `sound` is enabled. @default 'C:\\Windows\\Media\\Windows Notify Calendar.wav' */
  soundFile?: string
  /** PowerShell executable; Windows PowerShell 5.1 is required for the WinRT binding. @default 'powershell.exe' */
  powershell?: string
}

/** {@link Config} with every default applied. */
export type Options = Required<Config>

/** Defaults, merged under the row's `config`. */
export const DEFAULTS: Options = {
  notifyOnApproval: true,
  approvalDelayMs: 300,
  notifyOnTurnEnd: true,
  notifyOnTurnError: true,
  sound: true,
  appId: 'com.deepseek.dsh',
  soundFile: 'C:\\Windows\\Media\\Windows Notify Calendar.wav',
  powershell: 'powershell.exe',
}

/** Desktop copy stays Chinese; Web uses the Client locale. */
const t = fallbackTranslate('zh')

/** Loader row identity; independent from the package name. */
export const name = 'desktop-notify'

/** The shared source needs the live Agent registry for root-session filtering. */
export const inject = ['agents']

/**
 * Register the Host-side Windows notification path.
 *
 * @param ctx - Host-plane plugin context.
 * @param config - row configuration merged over {@link DEFAULTS}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  assertTarget(ctx, name)

  const options: Options = { ...DEFAULTS, ...config }

  // Register the click handler once; if it fails, notifications still work and
  // a click simply does not focus the window.
  try {
    ensureFocusHandler()
  } catch (error) {
    console.warn('[desktop-notify] cannot register the focus handler:', error)
  }

  ctx.effect(
    () => registerSessionNotifications(ctx, options, show),
    'desktop-notify: shared session notification source',
  )
}

/** The side effect used for one notification; injectable for tests. */
export type Notify = (options: Options, title: string, body: string) => void

/**
 * Subscribe the Windows delivery adapter to the shared notification source.
 *
 * Split out of {@link apply} so tests can run without writing the focus
 * protocol or spawning PowerShell.
 *
 * @param ctx - Host-plane plugin context.
 * @param options - fully resolved plugin options.
 * @param notify - notification side effect; defaults to {@link show}.
 * @returns disposer for the source and its subscription.
 */
export function registerSessionNotifications(ctx: Context, options: Options, notify: Notify = show): () => void {
  const source = createNotificationSource(ctx, {
    notifyOnApproval: options.notifyOnApproval,
    approvalDelayMs: options.approvalDelayMs,
    notifyOnTurnEnd: options.notifyOnTurnEnd,
    notifyOnTurnError: options.notifyOnTurnError,
  })

  const unsubscribe = source.subscribe((update) => {
    if (update.type !== 'show') return
    if (update.kind === 'approval') {
      const content = approvalContent({ toolName: update.toolName, reason: update.reason }, t)
      notify(options, content.title, content.body)
      return
    }
    const content = turnEndContent({
      kind: update.reasonKind,
      ...update.errorMessage === undefined ? {} : { error: { message: update.errorMessage } },
    }, t)
    if (content !== undefined) notify(options, content.title, content.body)
  })

  return () => {
    unsubscribe()
    source.dispose()
  }
}

/**
 * Resolve the Windows PowerShell executable.
 *
 * @param configured - `powershell.exe` or an explicit path.
 * @returns a path that exists, else the configured value.
 */
function resolvePowerShell(configured: string): string {
  if (configured !== 'powershell.exe') return configured
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(absolute) ? absolute : configured
}

/**
 * Show one notification without blocking the Host.
 *
 * @param options - resolved plugin config.
 * @param title - first toast line.
 * @param body - second toast line.
 */
function show(options: Options, title: string, body: string): void {
  const script = buildScript(title, body, options)
  const executable = resolvePowerShell(options.powershell)
  try {
    const child = spawn(executable, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { windowsHide: true, stdio: 'ignore' })
    child.on('error', (error: Error) => {
      console.warn('[desktop-notify] cannot start PowerShell:', error)
    })
    // `unref` lets the Host exit without waiting for the sound to finish.
    // `detached` is intentionally off: on Windows a DETACHED_PROCESS makes
    // powershell.exe exit immediately without running the encoded command.
    child.unref()
  } catch (error) {
    console.warn('[desktop-notify] cannot show notification:', error)
  }
}

/**
 * Build the PowerShell notification script. Every injected value is escaped
 * for both the PowerShell string literal and the toast XML.
 *
 * @param title - first toast line.
 * @param body - second toast line.
 * @param options - resolved plugin config.
 * @returns script passed to `-EncodedCommand`.
 */
export function buildScript(title: string, body: string, options: Options): string {
  const xml = '<toast activationType="protocol" launch="dsh-notify:focus">'
    + '<visual><binding template="ToastGeneric">'
    + `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>`
    + '</binding></visual><audio silent="true" /></toast>'

  return [
    "$ErrorActionPreference = 'Stop'",
    `$title = ${literal(title)}`,
    `$body = ${literal(body)}`,
    `$appId = ${literal(options.appId)}`,
    `$soundFile = ${literal(options.soundFile)}`,
    `$playSound = ${options.sound ? '$true' : '$false'}`,
    `$xml = ${literal(xml)}`,
    '$toastShown = $false',
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $doc.LoadXml($xml)',
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '  $toastShown = $true',
    '} catch { }',
    'if (-not $toastShown) {',
    '  try {',
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    Add-Type -AssemblyName System.Drawing',
    '    $icon = New-Object System.Windows.Forms.NotifyIcon',
    '    $icon.Icon = [System.Drawing.SystemIcons]::Information',
    '    $icon.Visible = $true',
    '    $icon.ShowBalloonTip(6000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)',
    '    Start-Sleep -Seconds 6',
    '    $icon.Dispose()',
    '  } catch { }',
    '}',
    'if ($playSound) {',
    '  try {',
    '    if (Test-Path -LiteralPath $soundFile) {',
    '      $player = New-Object -TypeName System.Media.SoundPlayer -ArgumentList $soundFile',
    '      $player.PlaySync()',
    '    } else {',
    '      [System.Media.SystemSounds]::Notification.Play()',
    '      Start-Sleep -Milliseconds 600',
    '    }',
    '  } catch {',
    '    try { [System.Media.SystemSounds]::Notification.Play() } catch { }',
    '  }',
    '}',
  ].join('\n')
}

/**
 * Escape one value as a PowerShell single-quoted literal.
 *
 * @param value - raw text.
 * @returns quoted literal.
 */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Escape text for XML character data.
 *
 * @param value - raw text.
 * @returns escaped text.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** VBScript that brings the running DSH window to the foreground. */
const FOCUS_SCRIPT = [
  'Option Explicit',
  'Dim sh, fso, logFile, f, svc, list, p',
  'Set sh = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'On Error Resume Next',
  'logFile = fso.GetSpecialFolder(2).Path & "\\dsh-notify-focus.log"',
  'Set f = fso.OpenTextFile(logFile, 8, True)',
  'f.WriteLine Now & " focus"',
  'f.Close',
  'Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
  `Set list = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='DeepSeek Harness.exe'")`,
  'For Each p In list',
  '  sh.AppActivate p.ProcessId',
  'Next',
].join('\r\n')

/**
 * Write the focus script and register the `dsh-notify:` protocol for it.
 *
 * Toast clicks cannot invoke Host code directly (an unpackaged Win32 app has
 * no notification activator), but a protocol activation launches this script,
 * which activates the existing window with `AppActivate`.
 */
function ensureFocusHandler(): void {
  const base = process.env.LOCALAPPDATA ?? process.env.TEMP
  if (base === undefined) throw new Error('LOCALAPPDATA is unavailable')

  const directory = join(base, 'dsh-notify')
  mkdirSync(directory, { recursive: true })
  const focusPath = join(directory, 'focus.vbs')
  writeFileSync(focusPath, FOCUS_SCRIPT, 'utf8')

  const registerPath = join(directory, 'register.vbs')
  writeFileSync(registerPath, buildRegisterScript(focusPath), 'utf8')

  const child = spawn(resolveWscript(), ['//B', '//Nologo', registerPath], {
    windowsHide: true,
    stdio: 'ignore',
  })
  child.on('error', (error: Error) => {
    console.warn('[desktop-notify] cannot register the focus protocol:', error)
  })
  child.unref()
}

/** Register `HKCU\Software\Classes\dsh-notify` and delete the setup script. */
function buildRegisterScript(focusPath: string): string {
  return [
    'Option Explicit',
    'Dim sh, fso',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'sh.RegWrite "HKCU\\Software\\Classes\\dsh-notify\\", "URL:DSH Notify"',
    'sh.RegWrite "HKCU\\Software\\Classes\\dsh-notify\\URL Protocol", ""',
    `sh.RegWrite "HKCU\\Software\\Classes\\dsh-notify\\shell\\open\\command\\", ${vbsString(`${resolveWscript()} `)} & Chr(34) & ${vbsString(focusPath)} & Chr(34) & " " & Chr(34) & "%1" & Chr(34)`,
    'On Error Resume Next',
    'fso.DeleteFile WScript.ScriptFullName, True',
  ].join('\r\n')
}

/** Escape one value as a VBScript string literal. */
function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Resolve the GUI-subsystem script host (never creates a console). */
function resolveWscript(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const absolute = join(root, 'System32', 'wscript.exe')
  return existsSync(absolute) ? absolute : 'wscript.exe'
}
