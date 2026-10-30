import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

/**
 * Locates the DSH CLI and exposes a single spawn shape.
 *
 * The `dsh` found on PATH wins over the copy shipped with the desktop app: an
 * npm-installed `dsh` runs on the default Node runtime, which is the intended
 * engine for `dsh web` (the Electron engine reports `process.versions.electron`
 * and therefore looks like a desktop Host). `DSH_CLI` still overrides both.
 *
 * Windows wrappers are not spawned directly (Node 24 refuses `.cmd`, `EINVAL`):
 * - the desktop `dsh.cmd` sets `ELECTRON_RUN_AS_NODE` and runs the bundled
 *   desktop executable against its CLI script — spawn that executable directly;
 * - npm/pnpm `dsh.cmd` shims run `node .../@deepseek-ai/dsh/lib/bin.js` — spawn the
 *   Node binary with that script.
 * A `cmd.exe /d /s /c` fallback keeps other layouts working.
 */
export interface DshRunner {
  /** Executable to spawn. */
  readonly command: string
  /** Human-readable origin (configured path or PATH entry). */
  readonly source: string
  /** Extra environment the wrapper would have set. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Pass the argument list verbatim, without Node's Windows quoting. Only the
   * `cmd.exe` fallback needs this; the engine path uses normal argv.
   */
  readonly verbatim: boolean
  /** Build the spawn argument list for one CLI invocation. */
  build(args: readonly string[]): string[]
}

export interface ResolveDshOptions {
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
}

const WINDOWS_RELATIVE = join('Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
const MAC_ABSOLUTE = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** Discover the CLI from DSH_CLI, PATH, then known install locations. */
export function resolveDsh(options: ResolveDshOptions = {}): DshRunner {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const explicit = env['DSH_CLI']
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`DSH_CLI does not exist: ${explicit}`)
    return createRunner(explicit, env, platform)
  }

  const candidates: string[] = []
  const add = (candidate: string | undefined): void => {
    if (candidate !== undefined && candidate !== '' && !candidates.includes(candidate)) candidates.push(candidate)
  }

  // PATH first: the default-Node CLI is the preferred `dsh web` engine.
  for (const name of platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat'] : ['dsh']) {
    add(findOnPath(name, env['PATH']))
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData !== '') add(join(localAppData, WINDOWS_RELATIVE))
  } else if (platform === 'darwin') {
    add(MAC_ABSOLUTE)
  }

  const found = candidates.find((candidate) => existsSync(candidate) && isFile(candidate))
  if (found === undefined) {
    throw new Error('cannot locate the dsh CLI; install it on PATH or set DSH_CLI to the dsh executable (dsh.cmd on Windows)')
  }
  return createRunner(found, env, platform)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findOnPath(name: string, pathValue: string | undefined): string | undefined {
  if (pathValue === undefined || pathValue === '') return undefined
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (existsSync(candidate) && isFile(candidate)) return candidate
  }
  return undefined
}

function createRunner(cliPath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DshRunner {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const engine = fromElectronWrapper(cliPath)
    if (engine !== undefined) return engine
    const npm = fromNpmShim(cliPath)
    if (npm !== undefined) return npm
    return {
      command: env['ComSpec'] ?? 'cmd.exe',
      source: cliPath,
      env: {},
      verbatim: true,
      // cmd /s strips one outer quote pair; the inner path stays quoted.
      build: (args) => ['/d', '/s', '/c', `"${[cliPath, ...args].map(quoteCmdArg).join(' ')}"`],
    }
  }
  return {
    command: cliPath,
    source: cliPath,
    env: {},
    verbatim: false,
    build: (args) => [...args],
  }
}

function fromElectronWrapper(cliPath: string): DshRunner | undefined {
  let text: string
  try {
    text = readFileSync(cliPath, 'utf8')
  } catch {
    return undefined
  }
  const match = /"([^"]+)"\s+--expose-internals\s+"([^"]+)"/.exec(text)
  if (match === null) return undefined

  const base = dirname(cliPath)
  const executable = resolve(expandCmdPath(match[1] ?? '', base))
  const script = resolve(expandCmdPath(match[2] ?? '', base))
  // `app.asar` is a virtual archive: Node cannot stat a path inside it, but
  // the Electron executable reads it natively. Only the executable must exist.
  if (!existsSync(executable)) return undefined

  return {
    command: executable,
    source: cliPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    verbatim: false,
    build: (args) => ['--expose-internals', script, ...args],
  }
}

/**
 * The npm/pnpm shim layouts:
 *   "%_prog%"  "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
 *   "%~dp0\node.exe"  "%~dp0\..\@deepseek-ai\dsh\lib\bin.js" %*
 * Spawn Node with that script so the web server is a direct child running on
 * the default Node runtime.
 */
function fromNpmShim(cliPath: string): DshRunner | undefined {
  let text: string
  try {
    text = readFileSync(cliPath, 'utf8')
  } catch {
    return undefined
  }
  // npm and pnpm generate different shims; both ultimately run this JS entry.
  const match = /(?:"%_prog%"|"%~dp0[\\/]node\.exe")\s+"([^"]+)"/.exec(text)
  if (match === null) return undefined

  const base = dirname(cliPath)
  const script = resolve(expandCmdPath(match[1] ?? '', base))
  if (!existsSync(script)) return undefined

  const adjacentNode = join(base, 'node.exe')
  const command = existsSync(adjacentNode) ? adjacentNode : process.execPath

  return {
    command,
    source: cliPath,
    env: {},
    verbatim: false,
    build: (args) => [script, ...args],
  }
}

/** Expand `%~dp0` / `%dp0%` (directory of the script, trailing separator). */
function expandCmdPath(value: string, base: string): string {
  // Backslashes belong to the .cmd syntax, even when a shim is inspected on
  // macOS. Forward slashes resolve on both hosts; a callback keeps literal $
  // characters in the directory from becoming replacement-string patterns.
  return value.replaceAll('\\', '/').replace(/%~dp0|%dp0%/gi, () => `${base}/`)
}

/** Minimal cmd.exe argument quoting; our arguments are paths and flags. */
function quoteCmdArg(value: string): string {
  if (value === '') return '""'
  if (!/[\s"&|<>^()]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}
