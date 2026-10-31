import { redactLaunchTokens } from './web-harness.js'

/** A single workflow command; diagnostic text cannot inject extra commands. */
export function failureAnnotation(detail: string): string {
  const escaped = redactLaunchTokens(detail).slice(0, 60000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  return `::error title=Test failure::${escaped}`
}
