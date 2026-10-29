import { join } from 'node:path'
import { isRecord, readJson } from './json.js'

/** A zero exit code alone does not prove that the browser ran every check. */
export function assertBrowserResults(directory: string, mode: 'baseline' | 'fixture'): void {
  const expected = mode === 'baseline' ? ['no-custom-plugins'] : [
    'slot-interaction-theme-locale-reload', 'notification-en', 'notification-zh', 'notification-denied',
  ]
  const results = readJson(join(directory, 'results.json'))
  if (!Array.isArray(results) || results.length !== expected.length
    || results.some((result, index) => !isRecord(result) || result['name'] !== expected[index] || result['ok'] !== true)) {
    throw new Error(`incomplete or failed ${mode} browser results; expected successful checks: ${expected.join(', ')}`)
  }
}
