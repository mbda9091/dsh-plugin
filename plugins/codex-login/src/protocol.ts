import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'

/** Public diagnostics contain no configuration values or credential payload. */
export type EnvironmentState = 'ready' | 'services-missing' | 'flow-missing' | 'route-missing' | 'configuration-unsupported'
export type AttemptState = 'running' | 'waiting' | 'authorized' | 'cancelled' | 'failed'
export type WirePrompt = Omit<Extract<AuthorizationPrompt, { kind: 'text' }>, 'signal'> & { id: string }
  | Omit<Extract<AuthorizationPrompt, { kind: 'secret' }>, 'signal'> & { id: string }
  | Omit<Extract<AuthorizationPrompt, { kind: 'select' }>, 'signal'> & { id: string }

export interface AttemptView {
  epoch: string
  revision: number
  attemptId: string
  state: AttemptState
  deadline: number
  notice?: AuthorizationNotice
  prompt?: WirePrompt
  error?: string
}

export interface StatusView {
  epoch: string
  revision: number
  environment: EnvironmentState
  credential: 'absent' | 'grant' | 'unexpected'
  writable: boolean
  busy: boolean
}
