import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isRecord, readJson, readText, writeText } from '../core/json.js'
import { compare, discoverPlugins } from '../core/plugins.js'
import type { Plugin } from '../core/plugins.js'
import { repoRoot } from '../core/repo.js'
import { platformLabel, surfaceLabel } from '../core/targets.js'

export interface CatalogOptions {
  readonly check: boolean
  readonly output?: string | undefined
}

/**
 * Generates CATALOG.md from each plugin's dsh.targets and zh locale metadata.
 * The file is generated but committed; --check verifies it is up to date.
 */
export function runCatalog(options: CatalogOptions): number {
  const configured = options.output
  const output = resolve(configured !== undefined && configured !== '' ? configured : join(repoRoot, 'CATALOG.md'))

  const plugins = discoverPlugins(repoRoot)
  if (plugins.length === 0) throw new Error('No plugin packages found.')

  const lines: string[] = [
    '# 插件目录',
    '',
    '> 本文件由 `node scripts/bootstrap.mjs catalog` 根据各插件 `package.json` 的 `dsh.targets` 生成，不要手动编辑。',
    '> 适用场景语义见 [docs/plugin-targets.md](docs/plugin-targets.md)。',
    '',
    '| 插件 | 包名 | 形态 | 平台 | 说明 |',
    '| --- | --- | --- | --- | --- |',
  ]

  const sorted = [...plugins].sort(
    (left, right) =>
      compare(left.surfaces.join(','), right.surfaces.join(',')) ||
      compare(left.platforms.join(','), right.platforms.join(',')) ||
      compare(left.packageName, right.packageName),
  )

  for (const plugin of sorted) {
    const locale = readZhMeta(plugin)
    const title = locale.title !== '' ? locale.title : plugin.packageName

    let description = locale.description
    if (description === '' && typeof plugin.manifest['description'] === 'string') description = plugin.manifest['description']
    description = description.replace(/^【[^】]*】\s*/, '')
    description = description.replace(/^\[[^\]]*\]\s*/, '')
    description = description.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()
    if (description === '') description = '—'

    lines.push(
      `| ${title} | \`${plugin.packageName}\` | ${surfaceLabel(plugin.surfaces, 'zh')} | ${platformLabel(plugin.platforms, 'zh')} | ${description} |`,
    )
  }

  lines.push('')
  lines.push('## 组合规则')
  lines.push('')
  lines.push('- 桌面应用（目标平台）：安装形态为“桌面”或“通用”、且平台覆盖目标平台的插件。')
  lines.push('- Web（目标平台）：安装形态为“Web”或“通用”、且平台覆盖目标平台的插件。')
  lines.push('- 平台列为“通用平台”的插件同时覆盖 macOS 与 Windows。')

  const content = `${lines.join('\n')}\n`

  if (options.check) {
    if (!existsSync(output)) {
      console.error(`catalog: ${output} is missing; run node scripts/bootstrap.mjs catalog`)
      return 1
    }
    const existing = readText(output).replace(/\r\n/g, '\n').replace(/^\uFEFF+/, '')
    if (existing !== content) {
      console.error(`catalog: ${output} is out of date; run node scripts/bootstrap.mjs catalog`)
      return 1
    }
    console.log('catalog: up to date')
    return 0
  }

  writeText(output, content)
  console.log(`catalog: wrote ${output}`)
  return 0
}

function readZhMeta(plugin: Plugin): { title: string; description: string } {
  const path = join(plugin.dir, 'locale', 'zh.json')
  try {
    if (!existsSync(path)) return { title: '', description: '' }
    const document = readJson(path)
    const meta = isRecord(document) ? document['meta'] : undefined
    return {
      title: isRecord(meta) && typeof meta['title'] === 'string' ? meta['title'] : '',
      description: isRecord(meta) && typeof meta['description'] === 'string' ? meta['description'] : '',
    }
  } catch {
    // The validator reports malformed locale JSON; the catalog falls back.
    return { title: '', description: '' }
  }
}
