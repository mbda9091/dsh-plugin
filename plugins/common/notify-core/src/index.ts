/** Shared, runtime-agnostic notification content for both delivery adapters. */

/** Client and Host locale dictionaries use the same keys. */
export type LocaleKey =
  | 'question.title'
  | 'question.body'
  | 'approval.title'
  | 'approval.body'
  | 'approval.body.reason'
  | 'approval.toolFallback'
  | 'turnEnd.completed.title'
  | 'turnEnd.completed.body'
  | 'turnEnd.maxTokens.title'
  | 'turnEnd.maxTokens.body'
  | 'turnEnd.error.title'
  | 'turnEnd.error.body'

/** Translate one shared notification key, optionally interpolating values. */
export type Translate = (key: LocaleKey, params?: Record<string, string>) => string

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<LocaleKey, string> = {
  'question.title': '需要你的回复',
  'question.body': '有问题等待你回答，请返回会话查看。',
  'approval.title': '需要确认权限',
  'approval.body': '{toolName} 正在请求授权',
  'approval.body.reason': '{toolName} 正在请求授权：{reason}',
  'approval.toolFallback': '工具',
  'turnEnd.completed.title': '对话已完成',
  'turnEnd.completed.body': '本轮回复已结束，可以回来查看了。',
  'turnEnd.maxTokens.title': '本轮已达到输出上限',
  'turnEnd.maxTokens.body': '任务可能尚未完成，请返回会话查看。',
  'turnEnd.error.title': '对话出错',
  'turnEnd.error.body': '{message}',
}

/** English dictionary, checked against the Chinese key set. */
export const en: Record<LocaleKey, string> = {
  'question.title': 'Reply needed',
  'question.body': 'A question needs your answer; return to the conversation.',
  'approval.title': 'Approval required',
  'approval.body': '{toolName} is requesting permission',
  'approval.body.reason': '{toolName} is requesting permission: {reason}',
  'approval.toolFallback': 'Tool',
  'turnEnd.completed.title': 'Turn completed',
  'turnEnd.completed.body': 'The reply has finished; you can come back now.',
  'turnEnd.maxTokens.title': 'Output limit reached',
  'turnEnd.maxTokens.body': 'The task may be unfinished; return to the conversation.',
  'turnEnd.error.title': 'Turn failed',
  'turnEnd.error.body': '{message}',
}

/**
 * Build a translator over one static dictionary.
 *
 * @param language - dictionary to use.
 * @returns translator with `{name}` interpolation.
 */
export function fallbackTranslate(language: 'zh' | 'en' = 'zh'): Translate {
  const dictionary = language === 'en' ? en : zh
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match)
  }
}

/** One notification's rendered content. */
export interface NotificationContent {
  readonly title: string
  readonly body: string
}

/** Approval details supplied by the Session event or the Client status row. */
export interface ApprovalInput {
  readonly toolName?: string | undefined
  readonly reason?: string | undefined
}

/** Structural view of a `turn/end` reason. */
export interface TurnEndReason {
  readonly kind: string
  readonly error?: { readonly message?: string | undefined } | undefined
}

/**
 * Collapse whitespace and bound one notification line.
 *
 * @param value - raw text.
 * @param max - maximum characters.
 * @returns clipped single-line text.
 */
export function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Render the approval notification shared by Desktop and Web.
 *
 * @param input - tool name and reason from the approval request.
 * @param t - translator for the active locale.
 * @returns title and body for the delivery adapter.
 */
export function approvalContent(input: ApprovalInput, t: Translate): NotificationContent {
  const toolName = typeof input.toolName === 'string' && input.toolName.trim() !== ''
    ? input.toolName.trim()
    : t('approval.toolFallback')
  const reason = typeof input.reason === 'string' ? clip(input.reason, 180) : ''
  return {
    title: t('approval.title'),
    body: reason === ''
      ? t('approval.body', { toolName })
      : t('approval.body.reason', { toolName, reason }),
  }
}

/**
 * Render a finished-turn notification, or `undefined` when the reason is not
 * user-facing. `aborted` is a deliberate user action and stays silent.
 *
 * @param reason - `turn/end` reason.
 * @param t - translator for the active locale.
 * @param outputLimit - Web opts into a stopped reminder; other consumers retain their existing copy.
 * @returns title and body for the delivery adapter, or `undefined`.
 */
export function turnEndContent(reason: TurnEndReason, t: Translate, outputLimit: 'completed' | 'stopped' = 'completed'): NotificationContent | undefined {
  switch (reason.kind) {
    case 'completed':
      return {
        title: t('turnEnd.completed.title'),
        body: t('turnEnd.completed.body'),
      }
    case 'max-tokens': {
      const prefix = outputLimit === 'stopped' ? 'turnEnd.maxTokens' : 'turnEnd.completed'
      return { title: t(`${prefix}.title`), body: t(`${prefix}.body`) }
    }
    case 'error': {
      const message = typeof reason.error?.message === 'string' ? clip(reason.error.message, 180) : ''
      return {
        title: t('turnEnd.error.title'),
        body: message === '' ? t('turnEnd.error.body', { message: '—' }) : t('turnEnd.error.body', { message }),
      }
    }
    default:
      return undefined
  }
}

/** Render one question batch without exposing options or full tool arguments. */
export function questionContent(question: string, t: Translate): NotificationContent {
  return { title: t('question.title'), body: clip(question, 180) || t('question.body') }
}
