import { parseArgs } from 'node:util'
import { loadCommandContext } from './core/command-context.js'
import { errorMessage } from './core/json.js'
import { envValue } from './core/config.js'
import { runProfileInstall } from './commands/profile-install.js'
import { runStatus } from './commands/status.js'

const usage = `Usage: node scripts/install.mjs install|status --profile NAME [options]
Target: --dsh-cli PATH, --home PATH, --platform mac|windows (defaults to current Node/DSH environment; Web only).
Install: --only PACKAGE,... --dry-run --rebuild --archive-root PATH --pnpm-script PATH
Status: --manifest PATH (optional installed-file comparison)
No local configuration or named targets. install reuses cached packages or builds/packs as needed.
Development/testing: node scripts/dev.mjs <command>.`

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return 0 }
  try {
    if (command !== 'install' && command !== 'status') throw new Error(`unsupported installation command: ${command}; ${usage}`)
    if (args.includes('--help')) { console.log(usage); return 0 }
    const { values } = parseArgs({ args, options: {
      profile: { type: 'string' }, 'dsh-cli': { type: 'string' }, home: { type: 'string' }, platform: { type: 'string' },
      'pnpm-script': { type: 'string' }, only: { type: 'string' },
      'dry-run': { type: 'boolean' }, rebuild: { type: 'boolean' }, 'archive-root': { type: 'string' }, manifest: { type: 'string' },
    } })
    const invalid = command === 'install' ? ['manifest'] : ['pnpm-script', 'only', 'dry-run', 'rebuild', 'archive-root']
    for (const key of invalid) if (Object.hasOwn(values, key)) throw new Error(`--${key} is not supported by ${command}`)
    const context = loadCommandContext({
      profile: values.profile, dshCli: values['dsh-cli'], home: values.home, platform: values.platform,
      pnpmScript: values['pnpm-script'],
    }, undefined, undefined, 'target')
    console.log(JSON.stringify({ target: context.target, sources: {
      dshCli: values['dsh-cli'] ? 'command line' : 'current Node global package',
      home: values.home ? 'command line' : envValue(process.env, 'DSH_HOME') ? 'DSH_HOME' : 'DSH default ~/.dsh',
      profile: 'command line', platform: values.platform ? 'command line' : 'current system',
    } }))
    return command === 'install'
      ? await runProfileInstall({ only: values.only, rebuild: values.rebuild ?? false, dryRun: values['dry-run'] ?? false, archiveRoot: values['archive-root'] }, context)
      : runStatus({ manifest: values.manifest }, context)
  } catch (error) { console.error(`error: ${errorMessage(error)}`); return 1 }
}
