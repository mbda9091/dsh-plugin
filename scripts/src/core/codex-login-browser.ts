import { isRecord } from './json.js'

/** The Codex adapter's offline browser contract; online OAuth is separate. */
export const codexBrowserChecks = {
  baseline: ['independent-baseline-no-panel'],
  fixture: ['native-flow-status-and-authentication', 'native-keyless-route-saved-through-model-settings',
    'native-slot-light-dark-en-zh', 'synthetic-select-text-device-code-sign-out-and-sensitive-cleanup',
    'synthetic-old-host-begin-response-rejected', 'reload-single-panel-native-credentials-unchanged'],
} as const

export function assertCodexBrowserReport(value: unknown, mode: 'baseline' | 'fixture'): void {
  if (!isRecord(value) || value.passed !== true || value.mode !== mode
    || JSON.stringify(value.checks) !== JSON.stringify(codexBrowserChecks[mode])) {
    throw new Error(`incomplete Codex ${mode} browser evidence`)
  }
}
