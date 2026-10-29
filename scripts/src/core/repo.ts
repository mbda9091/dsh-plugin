import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiled to <repo>/scripts/.build/core/, so the repository root sits three
// levels up. Deriving it from the module URL keeps the CLI independent of the
// current working directory.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
