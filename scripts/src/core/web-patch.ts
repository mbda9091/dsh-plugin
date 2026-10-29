import { readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { isRecord } from './json.js'

/** !!js stays inert here; only the DSH loader may evaluate it. */
function document(text: string, path: string) {
  const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] })
  const issue = doc.errors[0] ?? doc.warnings[0]
  if (issue !== undefined) {
    const line = issue.linePos?.[0]?.line
    throw new Error(`${path}${line === undefined ? '' : `:${line}`}: invalid YAML (${issue.code})`)
  }
  return doc
}

function rows(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${path}: patch must be an array of row objects`)
  for (const row of value) {
    if (typeof row.id !== 'string' && !Array.isArray(row.insert)) throw new Error(`${path}: each patch requires id or insert`)
  }
  return value
}

export function renderWebPatch(text: string, root: string, path = 'Web template'): string {
  const doc = document(text, path)
  const values = rows(doc.toJS({ maxAliasCount: 100 }), path)
  let expanded = 0
  for (const [index, row] of values.entries()) {
    if (row.id !== 'hmr' || !isRecord(row.config) || !Array.isArray(row.config.root)) continue
    for (const [entry, value] of row.config.root.entries()) {
      if (typeof value !== 'string' || !value.startsWith('${repoRoot}/')) {
        throw new Error(path + ': hmr.config.root entries must start with ${repoRoot}/')
      }
      const suffix = value.slice('${repoRoot}/'.length)
      if (!suffix || suffix.includes('${') || suffix.split(/[\\/]/).some(part => part === '..')) {
        throw new Error(`${path}: invalid HMR template path`)
      }
      doc.setIn([index, 'config', 'root', entry], join(root, suffix))
      expanded++
    }
  }
  if (expanded === 0) throw new Error(`${path}: no HMR path placeholders found`)
  // Reject placeholders in any other value without treating source as code.
  const remaining = JSON.stringify(doc.toJS({ maxAliasCount: 100 }))
  if (remaining.includes('${')) throw new Error(`${path}: placeholder outside supported HMR path fields`)
  return `# Generated for repository: ${JSON.stringify(resolve(root))}\n${doc.toString({ lineWidth: 0 })}`
}

export interface PatchInspection { roots: string[]; warnings: string[] }

/** Parse the user's YAML without changing it or executing expressions. */
export function inspectWebPatch(path: string, root: string): PatchInspection {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { throw new Error(`${path}: missing or unreadable; run config init`) }
  const values = rows(document(text, path).toJS({ maxAliasCount: 100 }), path)
  const warnings: string[] = []
  const marker = /^# Generated for repository: (.+)$/m.exec(text)?.[1]
  if (marker !== undefined) {
    try {
      const original: unknown = JSON.parse(marker)
      if (typeof original !== 'string' || normalize(original) !== normalize(resolve(root))) {
        warnings.push('repository location changed; review the absolute HMR paths in the local patch')
      }
    } catch { warnings.push('invalid repository location marker in the local patch') }
  }
  const roots: string[] = []
  for (const row of values) {
    if (row.id !== 'hmr') continue
    if (!isRecord(row.config) || !Array.isArray(row.config.root)) {
      warnings.push('HMR root is absent or dynamic; only DSH can verify its runtime value')
      continue
    }
    for (const entry of row.config.root) {
      if (isRecord(entry) && typeof entry.__jsExpr === 'string') {
        warnings.push('dynamic HMR path was not evaluated; DSH verifies it at startup')
      } else if (typeof entry !== 'string' || !isAbsolute(entry) || entry.includes('${')) {
        throw new Error(`${path}: HMR roots must be absolute paths or !!js expressions`)
      } else roots.push(entry)
    }
  }
  return { roots, warnings }
}
