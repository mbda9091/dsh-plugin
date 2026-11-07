/** Retired combined dispatcher. Kept only for an actionable migration error. */
export async function main(_argv: string[]): Promise<number> {
  console.error('combined CLI removed; use scripts/dev.mjs for development/testing or scripts/install.mjs install --profile NAME')
  return 1
}
