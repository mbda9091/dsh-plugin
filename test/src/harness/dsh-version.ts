import { readFileSync } from 'node:fs'

/** Match real-host fixtures and evidence to the workspace's exact DSH pin. */
export const workspaceDshVersion: string = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).devDependencies['@deepseek-ai/dsh']
