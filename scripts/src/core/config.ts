import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isRecord } from './json.js'
import { repoRoot } from './repo.js'
import { assertConfigReady } from './config-transaction.js'

export interface InstallTarget {
  name: string
  dshCli: string
  home: string
  profile: string
  surface: 'desktop' | 'web'
  platform: 'windows' | 'mac'
  binding?: import('./formal-target.js').TargetIdentity
}

export interface RepoConfig {
  $schema?: './schema.json'
  version: 2
  tools: { pnpmScript: string | null }
  web: { browser: 'edge' | 'default'; browserPath: string | null; openBrowser: boolean; startupTimeoutMs: number }
  test: { browser: 'chrome' | 'chromium'; browserPath: string | null; timeoutMs: number }
  targets: InstallTarget[]
  legacy: { dshCli: string | null }
}

export interface ConfigOverrides {
  dshCli?: string
  target?: string
  home?: string
  profile?: string
  surface?: string
  platform?: string
  pnpmScript?: string
  browser?: string
  browserPath?: string
  openBrowser?: boolean
  startupTimeoutMs?: number
  testBrowser?: string
  testBrowserPath?: string
  testTimeoutMs?: number
}

export interface ResolvedConfig {
  config: RepoConfig
  sources: Record<string, string>
}

export function configPaths(root: string = repoRoot) {
  return {
    example: join(root, 'scripts/config/example.json'),
    schema: join(root, 'scripts/config/schema.json'),
    local: join(root, 'scripts/config/local.json'),
    patchExample: join(root, 'profiles/web/cordis.patch.example.yml'),
    patch: join(root, 'profiles/web/cordis.local.patch.yml'),
  }
}

export function readConfigJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch {
    // Parser diagnostics can quote a secret value from the input.
    throw new Error(`${path}: cannot read valid JSON`)
  }
}

/** The deliberately small JSON Schema subset used by schema.json. Fail closed
 * when the schema grows: unsupported rules must never be silently ignored. */
export function validate(value: unknown, schema: unknown, field: string): void {
  if (!isRecord(schema)) throw new Error('invalid configuration schema')
  const supported = new Set(['$schema', 'title', 'description', 'type', 'const', 'enum',
    'properties', 'required', 'additionalProperties', 'minimum', 'maximum', 'pattern', 'items'])
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) throw new Error(`unsupported configuration schema keyword: ${key}`)
  }
  const fail = (rule: string): never => { throw new Error(`${field}: ${rule}`) }
  if ('const' in schema && value !== schema.const) fail(`expected ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join(', ')}`)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => type === 'object' ? isRecord(value)
      : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null
      : type === 'integer' ? Number.isSafeInteger(value)
      : typeof value === type)) fail(`expected ${types.join(' or ')}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`minimum is ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`maximum is ${schema.maximum}`)
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    fail('does not match required pattern')
  }
  if (Array.isArray(value) && schema.items !== undefined) value.forEach((child, index) => validate(child, schema.items, `${field}[${index}]`))
  if (isRecord(value) && isRecord(schema.properties)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) fail(`missing field ${key}`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) fail(`unknown field ${key}`)
      } else validate(child, schema.properties[key], `${field}.${key}`)
    }
  }
}

/** Validate against the same schema used by editors, without loading defaults. */
export function readConfigFile(path: string, schemaPath: string): RepoConfig {
  const value = readConfigJson(path)
  if (isRecord(value) && value.version === 1) throw new Error(`${path}: version 1; run config migrate --dry-run, then config migrate`)
  validate(value, readConfigJson(schemaPath), path)
  const names = (value as RepoConfig).targets.map(target => target.name)
  if (new Set(names).size !== names.length) throw new Error(`${path}.targets: duplicate name`)
  return value as RepoConfig
}

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.hasOwn(env, name) ? name : Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())
  const value = key === undefined ? undefined : env[key]
  return value === undefined || value.trim() === '' ? undefined : value
}

/** Normalize config paths independently of the caller's working directory. */
export function resolveConfig(
  input: RepoConfig, root: string, schemaPath: string,
  env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}, source = 'local.json',
): ResolvedConfig {
  const config = structuredClone(input)
  const sources: Record<string, string> = {}
  const assign = <T>(field: string, current: T, variable: string | undefined, explicit: T | undefined): T => {
    const fromEnv = variable === undefined ? undefined : envValue(env, variable)
    sources[field] = explicit !== undefined ? 'command line' : fromEnv !== undefined ? variable! : source
    return explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv as T : current
  }
  config.tools.pnpmScript = assign('tools.pnpmScript', config.tools.pnpmScript, 'DSH_PNPM', overrides.pnpmScript)
  config.web.browser = assign<string>('web.browser', config.web.browser, undefined, overrides.browser) as RepoConfig['web']['browser']
  config.web.browserPath = assign('web.browserPath', config.web.browserPath, undefined, overrides.browserPath)
  config.web.openBrowser = assign('web.openBrowser', config.web.openBrowser, undefined, overrides.openBrowser)
  config.web.startupTimeoutMs = assign('web.startupTimeoutMs', config.web.startupTimeoutMs, undefined, overrides.startupTimeoutMs)
  config.test.browser = assign<string>('test.browser', config.test.browser, 'DSH_E2E_BROWSER', overrides.testBrowser) as RepoConfig['test']['browser']
  config.test.browserPath = assign('test.browserPath', config.test.browserPath, 'CHROME_PATH', overrides.testBrowserPath)
  config.test.timeoutMs = assign('test.timeoutMs', config.test.timeoutMs, undefined, overrides.testTimeoutMs)
  validate(config, readConfigJson(schemaPath), 'effective configuration')
  const path = (value: string | null): string | null => {
    if (value === null) return null
    if (/[\0\r\n]/.test(value)) throw new Error('configuration path contains a control character')
    return resolve(root, value)
  }
  config.tools.pnpmScript = path(config.tools.pnpmScript)
  config.web.browserPath = path(config.web.browserPath)
  config.test.browserPath = path(config.test.browserPath)
  config.targets = config.targets.map(target => ({ ...target, dshCli: path(target.dshCli)!, home: path(target.home)! }))
  return { config, sources }
}

export function loadRepoConfig(
  root: string = repoRoot, env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {},
): ResolvedConfig {
  const paths = configPaths(root)
  assertConfigReady(root)
  if (!existsSync(paths.local)) throw new Error(`${paths.local}: missing; run node scripts/bootstrap.mjs config init`)
  return resolveConfig(readConfigFile(paths.local, paths.schema), root, paths.schema, env, overrides)
}
