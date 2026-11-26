import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { approvalContent, clip, fallbackTranslate, questionContent, turnEndContent } from '@mbda9091/notify-core'

const zh = fallbackTranslate('zh')
const en = fallbackTranslate('en')

describe('L1 notify-core: content', () => {
  it('renders bounded questions and localized empty summaries', () => {
    assert.deepEqual(questionContent('  Which\n option? ', zh), { title: '需要你的回复', body: 'Which option?' })
    assert.deepEqual(questionContent('', en), { title: 'Reply needed', body: 'A question needs your answer; return to the conversation.' })
    assert.equal(questionContent('q'.repeat(300), en).body.length, 180)
  })
  it('renders the approval title/body in both locales', () => {
    assert.deepEqual(approvalContent({ toolName: 'pwsh', reason: '  need\n access  ' }, zh), {
      title: '需要确认权限',
      body: 'pwsh 正在请求授权：need access',
    })
    assert.deepEqual(approvalContent({ toolName: 'pwsh', reason: 'access' }, en), {
      title: 'Approval required',
      body: 'pwsh is requesting permission: access',
    })
  })

  it('uses the tool fallback and omits an empty reason', () => {
    assert.deepEqual(approvalContent({}, zh), {
      title: '需要确认权限',
      body: '工具 正在请求授权',
    })
  })

  it('bounds the reason', () => {
    const body = approvalContent({ toolName: 'pwsh', reason: 'r'.repeat(500) }, zh).body
    assert.ok(body.endsWith('…'))
    assert.ok(body.length <= 'pwsh 正在请求授权：'.length + 180)
  })

  it('distinguishes successful completion from an output-limit stop', () => {
    assert.deepEqual(turnEndContent({ kind: 'completed' }, zh), {
      title: '对话已完成',
      body: '本轮回复已结束，可以回来查看了。',
    })
    assert.deepEqual(turnEndContent({ kind: 'max-tokens' }, zh, 'stopped'), {
      title: '本轮已达到输出上限',
      body: '任务可能尚未完成，请返回会话查看。',
    })
    assert.deepEqual(turnEndContent({ kind: 'max-tokens' }, en, 'stopped'), {
      title: 'Output limit reached',
      body: 'The task may be unfinished; return to the conversation.',
    })
  })

  it('preserves output-limit copy for consumers that do not opt into Web semantics', () => {
    assert.deepEqual(turnEndContent({ kind: 'max-tokens' }, en), turnEndContent({ kind: 'completed' }, en))
  })

  it('maps error and keeps the message bounded', () => {
    assert.deepEqual(turnEndContent({ kind: 'error', error: { message: '  boom\n happened  ' } }, zh), {
      title: '对话出错',
      body: 'boom happened',
    })
  })

  it('stays silent for aborted and plugin-extended reasons', () => {
    for (const kind of ['aborted', 'blocked', 'interrupted', 'forked', 'custom']) {
      assert.equal(turnEndContent({ kind }, zh), undefined)
    }
  })

  it('clips one line', () => {
    assert.equal(clip('  a \n b  ', 100), 'a b')
    assert.equal(clip('abcdef', 4), 'abc…')
    assert.equal(clip('abcd', 4), 'abcd')
  })
})
