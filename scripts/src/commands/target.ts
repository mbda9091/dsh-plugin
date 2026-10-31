import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCommandContext } from '../core/command-context.js'
import { configPaths, readConfigFile, readConfigJson, validate } from '../core/config.js'
import type { ConfigOverrides } from '../core/config.js'
import { assertConfigReady, commitConfig, digest, maintenancePaths } from '../core/config-transaction.js'
import { discoverTargets, inspectTarget, targetContext } from '../core/formal-target.js'
import { repoRoot } from '../core/repo.js'

export function runTarget(action: string, name: string | undefined, options: ConfigOverrides & { dryRun?: boolean }, root = repoRoot, env = process.env): number {
  if (action === 'discover') {
    if (name || Object.keys(options).some(k => options[k as keyof typeof options] !== undefined && k !== 'dryRun')) throw new Error('target discover accepts no target fields')
    console.log(JSON.stringify(discoverTargets(root, env), null, 2)); return 0
  }
  if (!['list', 'show', 'bind', 'unbind'].includes(action)) throw new Error('target requires discover|list|show NAME|bind NAME|unbind NAME')
  if (action !== 'bind' && Object.entries(options).some(([key, value]) => key !== 'dryRun' && value !== undefined)) throw new Error('target fields are only accepted by bind')
  assertConfigReady(root)
  const paths = configPaths(root), before = readFileSync(paths.local), disk = readConfigFile(paths.local, paths.schema)
  if (action === 'list') {
    if (name) throw new Error('target list accepts no name')
    console.log(JSON.stringify(disk.targets, null, 2)); return 0
  }
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('target NAME is required (letters, digits, dash, underscore)')
  if (action === 'show') {
    const context = loadCommandContext({ target: name }, root, env, 'target')
    console.log(JSON.stringify(inspectTarget(context), (key, value) => key === 'runner' ? undefined : value, 2)); return 0
  }
  if (action === 'bind') {
    const context = loadCommandContext(options, root, env, 'target')
    const { target, identity } = inspectTarget(context)
    const bound = { ...target, name, binding: identity }
    inspectTarget(targetContext(context, bound))
    disk.targets = [...disk.targets.filter(t => t.name !== name), bound]
  } else {
    if (!disk.targets.some(t => t.name === name)) throw new Error('unknown named target')
    disk.targets = disk.targets.filter(t => t.name !== name)
  }
  validate(disk, readConfigJson(paths.schema), 'target configuration')
  console.log(JSON.stringify({ action, name, targets: disk.targets, dryRun: !!options.dryRun }, null, 2))
  if (!options.dryRun) commitConfig(root, { changes: [{ name: 'local.json', before, after: Buffer.from(JSON.stringify(disk, null, 2) + '\n') }],
    inputs: [{ path: paths.local, hash: digest(before) }], backup: join(maintenancePaths(root).backups, `target-${randomUUID()}`) })
  return 0
}
