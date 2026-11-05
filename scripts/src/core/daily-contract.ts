import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// Shared delivery path guards; daily launcher lifecycle was removed.
export const dailyHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export function inside(base: string, path: string): boolean {
  const r = relative(resolve(base), resolve(path))
  return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)
}
/** Every existing component is checked, including dangling junctions. */
export function plainPath(path: string): void {
  if (!isAbsolute(path)) throw new Error('daily paths must be absolute')
  let current = resolve(path)
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`daily path is a link: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
export function separateDaily(root: string, forbidden: readonly string[]): void {
  plainPath(root)
  for (const path of forbidden) if (inside(path, root) || inside(root, path)) throw new Error(`daily paths overlap: ${root} / ${path}`)
}
