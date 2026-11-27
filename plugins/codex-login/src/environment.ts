import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { EnvironmentState } from './protocol.js'

/** This fixed, grammar-valid key is owned by the native adapter. */
export const KEY = 'llm-pi-ai/openai-codex' as CredentialKey
export const PROVIDER = 'openai-codex'

/** Settings descriptors deliberately expose unknown at their JSON boundary. */
function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
    value = Reflect.get(value, key)
  }
  return value
}

/** Diagnose the resolved route; never return the underlying settings to the browser. */
export function environment(ctx: Context): EnvironmentState {
  const auth = ctx.get('authorization')
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  if (!auth || !llm || !settings || !ctx.get('credentials')) return 'services-missing'
  if (!auth.describe(KEY)?.methods.some(method => method.id === 'oauth')) return 'flow-missing'
  const entry = llm.listConfigurableProviders().find(item => item.provider === PROVIDER)
  if (!entry || !llm.listProviders().some(item => item.id === PROVIDER)) return 'route-missing'
  if (entry.error || entry.declared || !entry.nativeAuth?.oauth) return 'configuration-unsupported'
  const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === entry.settingsNs)
  const profile = at(descriptor?.value, entry.settingsPath)
  if (typeof profile !== 'object' || profile === null) return 'configuration-unsupported'
  // Conservative: even a custom innocuous header requires the user to restore
  // the native route before this panel can claim subscription routing.
  for (const field of ['apiKeyEnv', 'apiKey', 'baseURL', 'api', 'headers']) {
    const value = at(profile, [field])
    if (value !== undefined && value !== null && value !== ''
      && !(field === 'headers' && typeof value === 'object' && Object.keys(value).length === 0)) {
      return 'configuration-unsupported'
    }
  }
  return 'ready'
}
