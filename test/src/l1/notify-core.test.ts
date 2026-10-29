import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { approvalContent, clip, fallbackTranslate, turnEndContent } from '@local/notify-core'

const zh = fallbackTranslate('zh')
const en = fallbackTranslate('en')

describe('L1 notify-core: content', () => {
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

  it('maps completed and max-tokens to the completion notification', () => {
    assert.deepEqual(turnEndContent({ kind: 'completed' }, zh), {
      title: '对话已完成',
      body: '本轮回复已结束，可以回来查看了。',
    })
    assert.deepEqual(turnEndContent({ kind: 'max-tokens' }, en), {
      title: 'Turn completed',
      body: 'The reply has finished; you can come back now.',
    })
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
