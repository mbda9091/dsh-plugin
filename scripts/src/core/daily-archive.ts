import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifact, ArtifactSet } from './artifacts.js'
import { assertArtifactsUnchanged } from './artifacts.js'
import { dailyHash, plainPath, separateDaily } from './daily-contract.js'
import type { Verification } from './artifact-verification.js'
import { verificationPath } from './artifact-verification.js'

export function archiveLocation(root: string, home: string, archive: string): void {
  separateDaily(home, [root])
  separateDaily(archive, [root, home])
  separateDaily(dirname(archive), [root, home])
  plainPath(join(dirname(archive), 'receipts'))
}
/** Preserve original evidence bytes. Existing batches can only gain identical inputs. */
export function archiveArtifacts(set: ArtifactSet, selected: readonly Artifact[], evidence: Verification, archive: string, home: string): Map<string, string> {
  archiveLocation(set.root, home, archive); assertArtifactsUnchanged(set)
  const directory = join(archive, set.manifest.batch), receipts = join(dirname(archive), 'receipts')
  plainPath(directory); mkdirSync(directory, { recursive: true }); mkdirSync(receipts, { recursive: true })
  const inputs = [
    { name: 'manifest.json', bytes: readFileSync(set.path), hash: set.hash },
    { name: `verification-${evidence.platform}.json`, bytes: readFileSync(verificationPath(set, evidence.platform)), hash: '' },
    ...selected.map(p => ({ name: p.path, bytes: readFileSync(join(dirname(set.path), p.path)), hash: p.sha256 })),
  ]
  // Compare the read evidence to the exact already validated object before writing.
  if (JSON.stringify(JSON.parse(inputs[1]!.bytes.toString())) !== JSON.stringify(evidence)) throw new Error('verification changed before archival')
  for (const item of inputs) {
    const path = join(directory, item.name); plainPath(path)
    const hash = dailyHash(item.bytes)
    if (item.hash && hash !== item.hash) throw new Error('archive input hash changed')
    if (existsSync(path) && dailyHash(readFileSync(path)) !== hash) throw new Error('archive collision: existing batch has different bytes')
  }
  for (const item of inputs) {
    const path = join(directory, item.name); plainPath(path)
    if (!existsSync(path)) writeFileSync(path, item.bytes, { flag: 'wx' })
    if (dailyHash(readFileSync(path)) !== dailyHash(item.bytes)) throw new Error('external archive verification failed')
  }
  assertArtifactsUnchanged(set)
  return new Map(selected.map(p => [p.name, join(directory, p.path)]))
}
export function saveDailyReceipt(archive: string, run: string, report: unknown): string {
  if (!/^run-[a-zA-Z0-9_-]+$/.test(run)) throw new Error('invalid receipt run')
  const directory = join(dirname(archive), 'receipts', run), path = join(directory, 'report.json'), next = join(directory, 'report.next.json')
  for (const file of [directory, path, next]) plainPath(file)
  mkdirSync(directory, { recursive: true })
  writeFileSync(next, JSON.stringify(report, null, 2) + '\n'); renameSync(next, path)
  return path
}
