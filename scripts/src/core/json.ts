import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Parses JSON without narrowing; callers validate the shape with `isRecord`. */
export function readJson(path: string): unknown {
  return JSON.parse(readText(path)) as unknown
}

/** Writes UTF-8 without a BOM, creating parent directories as needed. */
export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf8' })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** String items of a JSON array; anything else is dropped. */
export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
