import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isRecord } from './json.js'

export function environmentIds(suite: string): string[] {
  return [...(suite !== 'real' ? ['CFG-01', 'CFG-02', 'CFG-03', 'CFG-04', 'CFG-05', 'CFG-06', 'TOOL-01', 'TOOL-02', 'TOOL-03', 'TOOL-05', 'DEV-01', 'DEV-02', 'DEV-04', 'DEV-05', 'DEV-06', 'ISO-01', 'ISO-02', 'ISO-04', 'ISO-06'] : []),
    ...(suite !== 'fast' ? ['TOOL-04', 'DEV-03', 'ISO-01-real', 'ISO-02-real', 'ISO-03', 'ISO-05'] : [])]
}

/** Exit zero is insufficient: require the exact case set and assertion/cleanup evidence. */
export function assertEnvironmentResults(path: string, expected: readonly string[], startedAfter?: string): void {
  const report: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(report) || report.status !== 'passed' || !Array.isArray(report.results)
    || typeof report.started !== 'string' || (startedAfter !== undefined && report.started < startedAfter)
    || report.results.length !== expected.length) throw new Error('incomplete or failed environment report')
  for (const id of expected) {
    const matches = report.results.filter(r => isRecord(r) && r.id === id)
    const entry: unknown = matches[0]
    if (matches.length !== 1 || !isRecord(entry) || entry.status !== 'pass' || entry.evidence !== `${id}.json`) throw new Error(`missing passing evidence: ${id}`)
    const evidence: unknown = JSON.parse(readFileSync(join(dirname(path), `${id}.json`), 'utf8'))
    if (!isRecord(evidence) || evidence.id !== id || evidence.passed !== true || typeof evidence.cleanup !== 'string'
      || !/^(removed|retained --keep)/.test(evidence.cleanup)) throw new Error(`incomplete assertion/cleanup evidence: ${id}`)
  }
}
