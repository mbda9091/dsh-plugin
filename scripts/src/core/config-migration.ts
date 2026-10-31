import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPaths, readConfigFile, validate } from './config.js'
import type { RepoConfig } from './config.js'
import { assertConfigReady, commitConfig, digest, maintenancePaths, safeConfigPath } from './config-transaction.js'
import type { TransactionHooks, TransactionPlan } from './config-transaction.js'
import { isRecord } from './json.js'

export interface LegacyConfig { version: 1; tools: { dshCli: string | null; pnpmScript: string | null }; web: RepoConfig['web']; test: RepoConfig['test'] }
export function migrateV1(old: LegacyConfig): RepoConfig {
  return { $schema: './schema.json', version: 2, tools: { pnpmScript: old.tools.pnpmScript }, web: structuredClone(old.web), test: structuredClone(old.test), targets: [], legacy: { dshCli: old.tools.dshCli } }
}

export function planMigration(root: string): TransactionPlan | null {
  assertConfigReady(root)
  const paths = configPaths(root)
  const maintenance = maintenancePaths(root)
  const v1Schema = join(maintenance.directory, 'schema.v1.json')
  for (const path of [paths.local, paths.schema, v1Schema, maintenance.state, maintenance.backups]) safeConfigPath(root, path)
  const before = readFileSync(paths.local)
  const schemaBytes = readFileSync(paths.schema)
  const oldSchemaBytes = readFileSync(v1Schema)
  // Parse and validate the same bytes we later protect with the input hash.
  let value: unknown
  try { value = JSON.parse(before.toString('utf8')) as unknown } catch { throw new Error(`${paths.local}: cannot read valid JSON`) }
  if (isRecord(value) && value.version === 2) { readConfigFile(paths.local, paths.schema); return null }
  const parseSchema = (bytes: Buffer, path: string): unknown => {
    try { return JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error(`${path}: cannot read valid JSON`) }
  }
  validate(value, parseSchema(oldSchemaBytes, v1Schema), paths.local)
  const next = migrateV1(value as LegacyConfig)
  validate(next, parseSchema(schemaBytes, paths.schema), 'migration candidate')
  // Existing maintenance state belongs to another protocol: do not overwrite it.
  if (existsSync(maintenance.state)) throw new Error('existing maintenance record requires manual review')
  const after = Buffer.from(`${JSON.stringify(next, null, 2)}\n`)
  return {
    backup: join(maintenance.backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`),
    inputs: [{ path: paths.local, hash: digest(before) }, { path: paths.schema, hash: digest(schemaBytes) }, { path: v1Schema, hash: digest(oldSchemaBytes) }],
    changes: [
      { name: 'local.json', before, after },
      { name: '.local-maintenance.json', before: null, after: Buffer.from(JSON.stringify({ version: 1, migration: 'v1-v2', before: digest(before), after: digest(after) }, null, 2)) },
    ],
  }
}

export function migrateConfig(root: string, dryRun = false, hooks: TransactionHooks = {}): string {
  const plan = planMigration(root)
  if (plan === null) return 'no-op: configuration is already v2'
  const summary = `v1 → v2: preserve pnpm/browser/timeouts; tools.dshCli → legacy.dshCli (unverified); targets = []; personal YAML unchanged. Missing target: name/CLI/home/profile/surface/platform must be explicitly selected. Backup: ${plan.backup}`
  if (!dryRun) commitConfig(root, plan, hooks)
  return `${dryRun ? 'preview' : 'committed'}: ${summary}`
}
