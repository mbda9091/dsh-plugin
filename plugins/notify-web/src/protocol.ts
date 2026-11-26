import type { ApprovalShowUpdate, NotificationUpdate } from '@mbda9091/notify-host'

export const PROTOCOL_VERSION = 3

export interface QuestionShowUpdate {
  readonly type: 'show'
  readonly kind: 'question'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly question: string
}

export interface QuestionWithdrawUpdate {
  readonly type: 'withdraw'
  readonly kind: 'question'
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
}

export type PendingUpdate = ApprovalShowUpdate | QuestionShowUpdate
export type WebNotificationUpdate = NotificationUpdate | QuestionShowUpdate | QuestionWithdrawUpdate
