import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, isRecord, readJson, readText } from '../core/json.js'
import { discoverPlugins } from '../core/plugins.js'
import { repoRoot } from '../core/repo.js'
import { platformLabel, surfaceLabel } from '../core/targets.js'

const ALLOWED_SURFACES = ['desktop', 'web']
const ALLOWED_PLATFORMS = ['windows', 'mac']
const ALLOWED_TARGET_FIELDS = ['surfaces', 'platforms']

interface TargetListResult {
  readonly values: string[]
  readonly bad: string[]
}

/**
 * Validates every plugin's dsh.targets, locale scenario prefix, and README.
 * Called by `build`, including `build --check`; run it directly when adding or
 * changing a plugin, because errors point at the exact file to update.
 */
export function runCheckTargets(): number {
  const errors: string[] = []
  const plugins = discoverPlugins(repoRoot)
  if (plugins.length === 0) throw new Error('No plugin packages found.')

  for (const plugin of plugins) {
    const label = plugin.packageName
    const before = errors.length
    const targets = plugin.dsh['targets']

    if (!isRecord(targets)) {
      errors.push(`${label}: package.json is missing dsh.targets`)
      continue
    }

    const unknownFields = Object.keys(targets).filter((key) => !ALLOWED_TARGET_FIELDS.includes(key))
    if (unknownFields.length > 0) {
      errors.push(`${label}: dsh.targets has unknown field(s): ${unknownFields.join(', ')}`)
    }

    const surfaces = checkTargetList({ value: targets['surfaces'], kind: 'surface', allowed: ALLOWED_SURFACES, label, errors })
    const platforms = checkTargetList({ value: targets['platforms'], kind: 'platform', allowed: ALLOWED_PLATFORMS, label, errors })

    const client = plugin.dsh['client']
    if (client !== undefined && client !== null) {
      const platform = isRecord(client) ? client['platform'] : undefined
      if (platform !== 'web') errors.push(`${label}: dsh.client.platform must be 'web'`)
    }

    const targetsValid =
      surfaces.values.length > 0 && platforms.values.length > 0 && surfaces.bad.length === 0 && platforms.bad.length === 0

    if (targetsValid) {
      const zhPrefix = `【${surfaceLabel(surfaces.values, 'zh')} · ${platformLabel(platforms.values, 'zh')}】`
      const enPrefix = `[${surfaceLabel(surfaces.values, 'en')} · ${platformLabel(platforms.values, 'en')}]`
      const zhDescription = readLocaleDescription(join(plugin.dir, 'locale', 'zh.json'), `${label} locale/zh.json`, errors)
      const enDescription = readLocaleDescription(join(plugin.dir, 'locale', 'en.json'), `${label} locale/en.json`, errors)

      if (zhDescription !== null && !zhDescription.startsWith(zhPrefix)) {
        errors.push(`${label}: locale/zh.json description must start with '${zhPrefix}'`)
      }
      if (enDescription !== null && !enDescription.startsWith(enPrefix)) {
        errors.push(`${label}: locale/en.json description must start with '${enPrefix}'`)
      }
    }

    const readme = join(plugin.dir, 'README.md')
    if (!existsSync(readme)) {
      errors.push(`${label}: missing README.md`)
    } else if (!/^## 适用场景\s*$/m.test(readText(readme))) {
      errors.push(`${label}: README.md must contain a '## 适用场景' section`)
    }

    if (errors.length === before) {
      console.log(`· ${label.padEnd(26)} ${surfaces.values.join('+')}/${platforms.values.join('+')}  OK`)
    }
  }

  if (errors.length > 0) {
    console.error('')
    for (const message of errors) console.error(`error: ${message}`)
    console.error(`targets check failed: ${errors.length} error(s)`)
    return 1
  }

  console.log(`targets ok: ${plugins.length} plugin(s)`)
  return 0
}

function checkTargetList(input: {
  readonly value: unknown
  readonly kind: 'surface' | 'platform'
  readonly allowed: readonly string[]
  readonly label: string
  readonly errors: string[]
}): TargetListResult {
  const { value, kind, allowed, label, errors } = input

  if (!Array.isArray(value)) {
    errors.push(`${label}: dsh.targets.${kind}s must be a non-empty array`)
    return { values: [], bad: [] }
  }

  const values = value.map((item) => (typeof item === 'string' ? item : String(item)))
  if (values.length === 0) errors.push(`${label}: dsh.targets.${kind}s is empty`)

  const bad = values.filter((item) => !allowed.includes(item))
  if (bad.length > 0) {
    errors.push(`${label}: unsupported ${kind}(s): ${bad.join(', ')} (allowed: ${allowed.join(', ')})`)
  }

  const duplicates = findDuplicates(values)
  if (duplicates.length > 0) errors.push(`${label}: duplicate ${kind}(s): ${duplicates.join(', ')}`)

  return { values, bad }
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const value of values) {
    if (seen.has(value)) {
      if (!duplicates.includes(value)) duplicates.push(value)
    } else {
      seen.add(value)
    }
  }
  return duplicates
}

function readLocaleDescription(path: string, label: string, errors: string[]): string | null {
  if (!existsSync(path)) {
    errors.push(`${label}: missing ${path}`)
    return null
  }

  try {
    const document = readJson(path)
    const meta = isRecord(document) ? document['meta'] : undefined
    const description = isRecord(meta) && typeof meta['description'] === 'string' ? meta['description'] : ''
    if (description.trim() === '') {
      errors.push(`${label}: meta.description is empty`)
      return null
    }
    return description
  } catch (error) {
    errors.push(`${label}: cannot parse locale JSON: ${errorMessage(error)}`)
    return null
  }
}
