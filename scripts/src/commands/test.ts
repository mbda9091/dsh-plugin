import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { repoRoot } from '../core/repo.js'
import { runBuild } from './build.js'
import { commandEnv, configuredPnpm, loadCommandContext } from '../core/command-context.js'
import type { CommandContext } from '../core/command-context.js'

/** Test layers implemented as `node:test` files under `test/src/`. */
export const TEST_KINDS = ['l1', 'l2', 'l3'] as const
export type TestKind = (typeof TEST_KINDS)[number]

export interface TestOptions {
  /** Empty means every kind. */
  readonly kinds: readonly string[]
  readonly build: boolean
}

/**
 * Run the L1–L3 suites.
 *
 * Tests are TypeScript, compiled by `tsc` into `test/.build` before `node
 * --test` runs them; Vitest is deliberately not used here (see
 * docs/testing-plan.md §6/§9). Plugin packages must be built first because the
 * tests import their published entry points (`lib/index.js`), exactly what DSH
 * loads. `--skip-build` is for iterating when `lib/` is already current.
 */
export async function runTest(options: TestOptions, context: CommandContext = loadCommandContext()): Promise<number> {
  const kinds = options.kinds.length === 0 ? [...TEST_KINDS] : parseKinds(options.kinds)
  if (kinds.includes('l2')) configuredPnpm(context) // Real tarball contracts need pnpm.
  const env = commandEnv(context)

  if (options.build) {
    const buildCode = await runBuild({ check: false }, context)
    if (buildCode !== 0) return buildCode
  }

  const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) throw new Error('typescript is not installed. Run `pnpm install` first.')

  const project = join(repoRoot, 'test', 'tsconfig.json')
  if (!existsSync(project)) throw new Error(`test project not found: ${project}`)

  const buildDir = join(repoRoot, 'test', '.build')
  rmSync(buildDir, { recursive: true, force: true })

  console.log(`test: compiling ${project}`)
  const compiled = spawnSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit', env })
  if (compiled.error) throw new Error(`cannot run tsc: ${compiled.error.message}`)
  if (compiled.status !== 0) return compiled.status ?? 1

  const files = collectTests(buildDir, kinds)
  if (files.length === 0) throw new Error(`no compiled tests found for ${kinds.join(', ')} under ${buildDir}`)

  console.log(`test: ${files.length} file(s) for ${kinds.join(', ')}`)
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      // The sandbox denies piped child stdio (EPERM), so the runner must stay
      // in-process; one file at a time also keeps process-level stubs isolated.
      '--test-isolation=none',
      '--test-concurrency=1',
      '--test-reporter=spec',
      ...(env.GITHUB_ACTIONS === 'true' ? ['--test-reporter-destination=stdout',
        `--test-reporter=${new URL('../core/github-reporter.js', import.meta.url).href}`, '--test-reporter-destination=stderr'] : []),
      ...files.map((file) => relative(repoRoot, file)),
    ],
    { cwd: repoRoot, stdio: 'inherit', env },
  )
  if (result.error) throw new Error(`cannot run node --test: ${result.error.message}`)
  return result.status ?? 1
}

function parseKinds(values: readonly string[]): TestKind[] {
  const kinds: TestKind[] = []
  for (const value of values) {
    for (const part of value.split(',')) {
      const kind = part.trim().toLowerCase()
      if (kind === '') continue
      if (!TEST_KINDS.includes(kind as TestKind)) {
        throw new Error(`unknown test kind '${kind}'; use ${TEST_KINDS.join(', ')}`)
      }
      if (!kinds.includes(kind as TestKind)) kinds.push(kind as TestKind)
    }
  }
  if (kinds.length === 0) throw new Error(`no test kind selected; use ${TEST_KINDS.join(', ')}`)
  return kinds
}

/** Depth-first, code-unit ordered list of compiled `*.test.js` files. */
function collectTests(buildDir: string, kinds: readonly TestKind[]): string[] {
  if (!existsSync(buildDir)) return []
  const found: string[] = []

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.test.js')) continue
      const relativePath = relative(buildDir, path)
      const [first] = relativePath.split(sep)
      if (first !== undefined && (kinds as readonly string[]).includes(first)) found.push(path)
    }
  }

  walk(buildDir)
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}
