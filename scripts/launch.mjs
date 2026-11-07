// Shared startup only: compile scripts/src with the
// repository's own tsc, then run the emitted CLI. Everything else is TypeScript.
//
// Used by dev.mjs and install.mjs.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function launch(entry) {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = dirname(here)
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')

  if (process.versions.node.split('.')[0] !== '24' || process.versions.electron !== undefined) {
    console.error(`ordinary Node 24 required; current Node ${process.versions.node}; select Node 24 explicitly`)
    process.exit(1)
  }

  if (!existsSync(tsc)) {
    console.error('typescript is not installed. Run `pnpm install` first.')
    process.exit(1)
  }

  // stdio must be inherited: DSH's sandbox denies piped child stdio (EPERM).
  const compiled = spawnSync(process.execPath, [tsc, '-p', join(here, 'tsconfig.json')], {
    stdio: 'inherit',
  })
  if (compiled.error) {
    console.error(`cannot run tsc: ${compiled.error.message}`)
    process.exit(1)
  }
  if (compiled.status !== 0) {
    process.exit(compiled.status ?? 1)
  }

  const { main } = await import(pathToFileURL(join(here, '.build', entry)).href)
  process.exitCode = await main(process.argv.slice(2))
}
