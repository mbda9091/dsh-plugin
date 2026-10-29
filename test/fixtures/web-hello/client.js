/** Test fixture: actual composer slot, host round-trip, and host locale service. */
window.__DSH_WEB_HELLO__ = { factory: false, applied: false, registered: false, error: null, slot: null }
window.__ModuleLoader__.load({
  id: '@local/web-hello',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const state = window.__DSH_WEB_HELLO__
    state.factory = true
    return {
      inject: ['slots', 'locale', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        state.applied = true
        // Test setup uses the real controllers, avoiding a native folder picker in CI.
        state.openWorkspace = async (path) => {
          try {
            const workspace = await ctx.get('workspaces').create({ path })
            const sessionId = await ctx.get('uiWorkspace').connectWorkspace(workspace.workspaceId)
            const response = await fetch(new URL('api/web-hello/seed', document.baseURI), {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
            })
            if (!response.ok) throw new Error(`seed: ${response.status} ${await response.text()}`)
            state.sessionId = sessionId
            ctx.get('uiWorkspace').openSession(sessionId)
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error)
          }
        }
        const locale = ctx.get('locale')
        const t = locale.bind('web-hello')
        ctx.effect(() => locale.register('web-hello', {
          en: { label: 'Host echo', send: 'Send to Host', waiting: 'Waiting', failed: 'Failed' },
          zh: { label: '主机回声', send: '发送到主机', waiting: '等待中', failed: '失败' },
        }))
        function WebHello() {
          React.useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot())
          const [text, setText] = React.useState('')
          const [result, setResult] = React.useState('')
          async function send() {
            setResult(t('waiting'))
            try {
              const response = await fetch(new URL('api/web-hello/echo', document.baseURI), {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
              })
              if (!response.ok) throw new Error(`echo: ${response.status}`)
              const data = await response.json()
              setResult(`${data.text} #${data.count}`)
            } catch (error) {
              console.error(error)
              setResult(t('failed'))
            }
          }
          return h('section', { 'data-testid': 'web-hello', style: {
            color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
            padding: 8, display: 'flex', gap: 8, alignItems: 'center',
          } },
          h('label', null, t('label'), h('input', { 'data-testid': 'web-hello-input', value: text, onChange: event => setText(event.target.value) })),
          h('button', { type: 'button', onClick: send }, t('send')),
          h('output', { 'data-testid': 'web-hello-result' }, result),
          h('button', { type: 'button', onClick: () => locale.setLocale('en') }, 'English'),
          h('button', { type: 'button', onClick: () => locale.setLocale('zh') }, '中文'))
        }
        ctx.slots.inject('conversation.composer.dock', () => {
          const dispose = ctx.slots.register({ name: 'conversation.composer.dock', id: 'web-hello', order: 5 }, WebHello)
          state.registered = true
          state.slot = 'conversation.composer.dock'
          return () => { state.registered = false; dispose() }
        })
      },
    }
  },
})
