import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { LoginController } from './controller.js'
import { KEY } from './environment.js'
import { registerRoutes } from './http.js'
import { assertTarget } from './targets.js'

export const name = 'codex-login'
// Other services remain optional so the panel can explain missing capabilities.
export const inject = ['connection']
export interface Config {
  /** Maximum lifetime of a plugin-owned login attempt. @default 600000 */
  loginTimeoutMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  assertTarget(ctx, name)
  const controller = new LoginController(ctx, config.loginTimeoutMs ?? 600_000)
  ctx.on('credentials/record-updated', key => { if (key === KEY) controller.changed() })
  ctx.on('authorization/settled', key => { if (key === KEY) controller.changed() })
  ctx.on('settings/document-updated', () => controller.changed())
  ctx.on('llm/adapters-updated', () => controller.changed())
  ctx.effect(() => {
    const unregister = registerRoutes(ctx, controller)
    return async () => { controller.dispose(); await unregister() }
  })
}
