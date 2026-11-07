import { resolve } from 'node:path'
import { envValue } from './config.js'
import type { ConfigOverrides, RepoConfig } from './config.js'

export type RuntimeSettings = Pick<RepoConfig, 'tools' | 'web' | 'test'>

/** In-memory defaults only. No local JSON, migration state, or target registry. */
export function runtimeSettings(overrides: ConfigOverrides, env: NodeJS.ProcessEnv, testing: boolean): RuntimeSettings {
  const path = (value: string | undefined): string | null => {
    if (value === undefined) return null
    if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error('invalid tool/browser path')
    return resolve(value)
  }
  const timeout = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('timeout must be a positive integer no greater than 2147483647 ms')
    return value
  }
  const browser = overrides.browser ?? 'edge'
  const testBrowser = overrides.testBrowser ?? (testing ? envValue(env, 'DSH_E2E_BROWSER') : undefined) ?? 'chrome'
  if (browser !== 'edge' && browser !== 'default') throw new Error('browser must be edge or default')
  if (testBrowser !== 'chrome' && testBrowser !== 'chromium') throw new Error('test browser must be chrome or chromium')
  return {
    tools: { pnpmScript: path(overrides.pnpmScript ?? envValue(env, 'DSH_PNPM')) },
    web: { browser, browserPath: path(overrides.browserPath), openBrowser: overrides.openBrowser ?? true, startupTimeoutMs: timeout(overrides.startupTimeoutMs, 30000) },
    test: { browser: testBrowser, browserPath: path(overrides.testBrowserPath ?? (testing ? envValue(env, 'CHROME_PATH') : undefined)), timeoutMs: timeout(overrides.testTimeoutMs, 120000) },
  }
}
