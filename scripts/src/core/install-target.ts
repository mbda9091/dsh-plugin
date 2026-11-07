import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { envValue } from './config.js'
import type { ConfigOverrides, InstallTarget } from './config.js'
import { assertExternalDsh, webDsh } from './config-tools.js'
import { runToTemporaryFiles } from './exec.js'

/** DSH 0.2.2-rc.1 dsh-home-paths contract: explicit > DSH_HOME > ~/.dsh. */
export function installHome(explicit: string | undefined, env: NodeJS.ProcessEnv, userHome = homedir()): string {
  const value = explicit ?? envValue(env, 'DSH_HOME') ?? join(userHome, '.dsh')
  if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error('invalid installation home')
  return resolve(value === '~' ? userHome : /^~[/\\]/.test(value) ? join(userHome, value.slice(2)) : value)
}

/** Only npm global layouts belonging to the selected Node. Never workspace .bin. */
export function nodeDsh(root: string, env: NodeJS.ProcessEnv, nodePath = process.execPath): string {
  const bins = new Set([dirname(nodePath), dirname(realpathSync(nodePath))])
  for (const bin of (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    try { if (realpathSync(join(bin, process.platform === 'win32' ? 'node.exe' : 'node')) === realpathSync(nodePath)) bins.add(bin) } catch { /* Not this Node's bin directory. */ }
  }
  const entries = new Set<string>()
  for (const bin of bins) {
    entries.add(join(bin, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    entries.add(join(bin, '../lib/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  }
  // npm owns the configured global prefix (notably AppData on Windows). Ask
  // only npm shipped beside this Node; never run a PATH shim or install tools.
  const npm = [...bins].flatMap(bin => [join(bin, 'node_modules/npm/bin/npm-cli.js'), join(bin, '../lib/node_modules/npm/bin/npm-cli.js')]).find(existsSync)
  if (npm) {
    let prefix: string
    try {
      const result = runToTemporaryFiles(root, nodePath, [npm, 'prefix', '--global'], { env, timeoutMs: 10000 })
      if (result.status !== 0 || result.timedOut) throw new Error('npm prefix probe failed')
      prefix = result.stdout.trim()
    }
    catch { throw new Error('cannot resolve current Node npm global prefix; pass --dsh-cli PATH explicitly') }
    if (!isAbsolute(prefix) || /[\0\r\n]/.test(prefix)) throw new Error('invalid npm global prefix; pass --dsh-cli PATH explicitly')
    entries.add(join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@deepseek-ai/dsh/lib/bin.js'))
  }
  const found = new Set<string>()
  for (const entry of entries) {
    if (!existsSync(entry)) continue
    assertExternalDsh(entry, root, env)
    webDsh(entry, env)
    found.add(realpathSync(entry))
  }
  if (found.size !== 1) throw new Error(`current Node has ${found.size} matching external DSH entries; pass --dsh-cli PATH explicitly`)
  return [...found][0]!
}

export function resolveInstallTarget(options: ConfigOverrides, root: string, env: NodeJS.ProcessEnv): InstallTarget {
  if (options.target !== undefined) throw new Error('--target was removed; pass --profile and optional --dsh-cli/--home')
  if (!options.profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.profile)) throw new Error('--profile is required and must be a valid profile name')
  if (options.surface !== undefined && options.surface !== 'web') throw new Error('installation supports Web only')
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : undefined
  if (!platform || (options.platform !== undefined && options.platform !== platform)) throw new Error('target platform must match the current supported machine')
  if (options.dshCli !== undefined && (!options.dshCli.trim() || /[\0\r\n]/.test(options.dshCli))) throw new Error('invalid --dsh-cli path')
  const dshCli = options.dshCli === undefined ? nodeDsh(root, env) : resolve(options.dshCli)
  return { name: 'explicit', dshCli, home: installHome(options.home, env), profile: options.profile, surface: 'web', platform }
}
