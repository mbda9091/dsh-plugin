/* Classic-script entry: React and UI services come from the DSH module table. */
window.__ModuleLoader__.load({
  id: '@mbda9091/codex-login',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const dictionaries = {
      zh: {
        title: 'Codex 订阅', intro: '使用 ChatGPT 账号登录，模型推理、工具和子 Agent 由 DSH 执行。',
        'services-missing': '宿主授权、凭证或模型服务未就绪。',
        'flow-missing': '宿主尚未提供 Codex OAuth 登录流程。',
        'route-missing': '请先在上方添加 OpenAI Codex 模型提供方，保持 API Key 为空。',
        'configuration-unsupported': '请恢复原生订阅路由：移除 API Key 引用、自定义端点、协议或请求头。',
        ready: '原生订阅路由已启用', absent: '尚未保存授权', grant: '已保存授权', unexpected: '存在非预期凭证记录',
        savedHint: '已保存不代表套餐、额度或模型可用。请在普通会话选择 OpenAI Codex 模型验证。',
        login: '登录 ChatGPT', retry: '重新登录', cancel: '取消登录', refresh: '刷新状态', signOut: '本地退出',
        running: '正在登录', waiting: '等待你的操作', authorized: '本次授权已保存', cancelled: '本次登录已取消', failed: '本次登录失败',
        open: '打开授权页面', code: '设备码', answer: '提交回答', input: '授权回答',
        remaining: '本插件剩余时间', seconds: '秒', busy: '登录或退出正在进行中；其他页面不会收到本次授权提示。',
        reconnecting: '连接已断开，正在重新连接；不会重新启动登录。',
        confirmLogin: '重新登录将覆盖当前共享授权，失败或取消不会主动删除旧授权。',
        confirmSignOut: '仅删除本地授权，可能影响同一 DSH home 的其他 profile；不撤销服务端授权。',
        continue: '确认继续', back: '返回', loading: '正在读取授权状态…',
        error: '操作未完成，请刷新状态后重试。',
        'authorization-failed': '原生授权未完成，请检查账号和网络后重试。',
        'stale-host': '宿主已重新加载，请刷新状态后重新操作。', busyError: '已有登录或退出正在进行，请等待结束。',
        'invalid-answer': '请选择有效选项或填写授权回答。', 'prompt-expired': '该问题已结束，请按最新提示操作。',
        'sign-out-failed': '本地授权未能删除，请检查凭证存储后重试。',
        note: 'Linux Web · 本机授权 · 授权信息不会保存在浏览器中',
      },
      en: {
        title: 'Codex subscription', intro: 'Sign in with ChatGPT. DSH continues to run inference, tools and subagents.',
        'services-missing': 'The host authorization, credentials or model service is unavailable.',
        'flow-missing': 'The host does not offer the Codex OAuth flow yet.',
        'route-missing': 'Add OpenAI Codex above first. Leave the API key blank.',
        'configuration-unsupported': 'Restore native subscription routing: remove key references, custom endpoints, protocols or headers.',
        ready: 'Native subscription route enabled', absent: 'No saved authorization', grant: 'Authorization saved', unexpected: 'Unexpected credential record',
        savedHint: 'Saved authorization does not confirm plan, quota or model availability. Select an OpenAI Codex model in a normal conversation to verify.',
        login: 'Sign in with ChatGPT', retry: 'Sign in again', cancel: 'Cancel login', refresh: 'Refresh status', signOut: 'Sign out locally',
        running: 'Signing in', waiting: 'Waiting for you', authorized: 'This authorization was saved', cancelled: 'This login was cancelled', failed: 'This login failed',
        open: 'Open authorization page', code: 'Device code', answer: 'Submit answer', input: 'Authorization answer',
        remaining: 'Plugin time remaining', seconds: 'seconds', busy: 'A login or sign-out is in progress. Other pages cannot see its private prompts.',
        reconnecting: 'Disconnected. Reconnecting without restarting login.',
        confirmLogin: 'Signing in again replaces the shared authorization. Failure or cancellation does not delete the existing grant.',
        confirmSignOut: 'Delete local authorization only. Other profiles in the same DSH home may be affected. Server access is not revoked.',
        continue: 'Continue', back: 'Back', loading: 'Reading authorization status…',
        error: 'The operation did not complete. Refresh status and try again.',
        'authorization-failed': 'Native authorization did not complete. Check your account and connection, then retry.',
        'stale-host': 'The host reloaded. Refresh status before continuing.', busyError: 'A login or sign-out is already in progress.',
        'invalid-answer': 'Choose a valid option or enter an authorization answer.', 'prompt-expired': 'This prompt has ended. Follow the latest prompt.',
        'sign-out-failed': 'Local authorization could not be deleted. Check credential storage and retry.',
        note: 'Linux Web · Local authorization · No authorization data saved in the browser',
      },
    }
    const css = `
      .codex-login { margin-block: 20px; padding: 20px; border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
      .codex-login h3 { margin: 0; font-size: 16px; font-weight: 600; }
      .codex-login p { margin: 8px 0; line-height: 1.6; }
      .codex-login .muted { color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .codex-login .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .codex-login .badge { border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: 20px; padding: 3px 10px; font-size: 12px; }
      .codex-login button, .codex-login input, .codex-login select { font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: 7px; padding: 8px 12px; }
      .codex-login button { cursor: pointer; }
      .codex-login button:disabled { opacity: .5; cursor: default; }
      .codex-login button.primary { font-weight: 600; background: var(--dsw-alias-interactive-bg-hover); }
      .codex-login .interaction { margin-block: 14px; padding: 14px; border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: 8px; }
      .codex-login input, .codex-login select { box-sizing: border-box; width: 100%; margin-block: 8px; }
      .codex-login a { color: var(--dsw-alias-link); text-decoration: underline; }
      .codex-login code { font: inherit; font-family: monospace; font-size: 20px; letter-spacing: 2px; user-select: all; }
      .codex-login :focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 3px; }
    `
    const active = view => view && ['running', 'waiting'].includes(view.state)
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        ctx.effect(() => locale.register('codex-login', dictionaries))
        const t = locale.bind('codex-login')
        function Panel() {
          React.useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot())
          const [status, setStatus] = React.useState(null)
          const [attemptId, setAttemptId] = React.useState(null)
          const [attempt, setAttempt] = React.useState(null)
          const [answer, setAnswer] = React.useState('')
          const [pending, setPending] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [confirmation, setConfirmation] = React.useState(null)
          const [connected, setConnected] = React.useState(true)
          const [now, setNow] = React.useState(Date.now())
          const owned = React.useRef(null)
          const selectedAttempt = React.useRef(null)
          const current = React.useRef(null)
          const live = React.useRef(true)
          const requestSequence = React.useRef(0)
          const api = (op, params = '') => new URL(`api/codex-login/${op}${params}`, document.baseURI)
          async function request(op, data) {
            const options = data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}
            // Network failures may hide a successful write. Retry the identical receipt.
            let response
            try { response = await fetch(api(op), { ...options, cache: 'no-store' }) }
            catch { response = await fetch(api(op), { ...options, cache: 'no-store' }) }
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'error')
            return result
          }
          async function refresh() {
            const sequence = ++requestSequence.current
            try {
              const next = await request('status')
              if (!live.current || sequence !== requestSequence.current) return
              const previous = current.current
              if (previous?.epoch === next.epoch && previous.revision > next.revision) return
              if (previous && previous.epoch !== next.epoch) {
                owned.current = null
                selectedAttempt.current = null
                setAttemptId(null)
                setAttempt(null)
              }
              current.current = next
              setStatus(next)
            } catch { if (live.current) setError('error') }
          }
          function abandon() {
            const handle = owned.current
            if (handle) void fetch(api('cancel'), {
              method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(handle),
            }).catch(() => {})
          }
          React.useEffect(() => {
            live.current = true
            void refresh()
            window.addEventListener('focus', refresh)
            window.addEventListener('pagehide', abandon)
            return () => {
              live.current = false
              abandon()
              window.removeEventListener('focus', refresh)
              window.removeEventListener('pagehide', abandon)
            }
          }, [])
          React.useEffect(() => {
            if (!status) return
            const epoch = status.epoch
            let listening = true
            const query = new URLSearchParams({ epoch, ...(attemptId ? { attemptId } : {}) })
            const source = new EventSource(api('events', `?${query}`))
            source.onopen = () => { setConnected(true); void refresh() }
            source.onerror = () => { setConnected(false); void refresh() }
            source.addEventListener('state', event => {
              const next = JSON.parse(event.data)
              if (!listening || current.current?.epoch !== epoch || selectedAttempt.current !== attemptId) return
              if (attemptId && next.attemptId === attemptId && next.epoch === epoch) {
                setAttempt(old => old?.attemptId === attemptId && old.revision > next.revision ? old : next)
                if (!active(next) && owned.current?.attemptId === attemptId) owned.current = null
              }
              void refresh()
            })
            return () => { listening = false; source.close() }
          }, [status?.epoch, attemptId])
          React.useEffect(() => { setAnswer('') }, [attempt?.prompt?.id])
          React.useEffect(() => {
            if (!active(attempt)) return
            const timer = setInterval(() => setNow(Date.now()), 1000)
            return () => clearInterval(timer)
          }, [attempt?.state])
          async function action(op) {
            if (!current.current || pending) return
            setPending(true)
            setError(null)
            setConfirmation(null)
            const epoch = current.current.epoch
            try {
              if (op === 'begin' || op === 'sign-out') {
                const result = await request(op, { epoch, requestId: `${Date.now()}-${crypto.randomUUID()}` })
                if (current.current?.epoch !== epoch) throw new Error('stale-host')
                if (op === 'begin') {
                  owned.current = { epoch, attemptId: result.attemptId }
                  selectedAttempt.current = result.attemptId
                  if (!live.current) { abandon(); return }
                  setAttempt(null)
                  setAttemptId(result.attemptId)
                } else {
                  owned.current = null
                  selectedAttempt.current = null
                  if (live.current) { setAttemptId(null); setAttempt(null) }
                }
              } else if (op === 'cancel' && owned.current) await request(op, owned.current)
              else if (op === 'answer' && attempt?.prompt) await request(op, { epoch, attemptId, promptId: attempt.prompt.id, value: answer })
            } catch (failure) {
              if (live.current) setError(failure.message === 'busy' ? 'busyError' : dictionaries.en[failure.message] ? failure.message : 'error')
            } finally {
              if (live.current) { setPending(false); void refresh() }
            }
          }
          const button = (label, onClick, disabled = false, primary = false) => h('button', { type: 'button', disabled, onClick, className: primary ? 'primary' : undefined }, t(label))
          const prompt = attempt?.prompt
          const notice = attempt?.notice
          let link
          try {
            const parsed = new URL(notice?.url)
            if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) link = parsed.href
          } catch { /* no valid link */ }
          return h('section', { className: 'codex-login', 'data-testid': 'codex-login', 'aria-label': t('title') },
            h('style', null, css),
            h('div', { className: 'row' }, h('h3', null, t('title')), status && h('span', { className: 'badge', 'data-testid': 'codex-login-credential' }, t(status.credential))),
            h('p', { className: 'muted' }, t('intro')),
            h('p', { 'data-testid': 'codex-login-environment' }, t(status?.environment || 'loading')),
            status?.credential === 'grant' && h('p', { className: 'muted' }, t('savedHint')),
            status?.busy && !active(attempt) && h('p', { role: 'status' }, t('busy')),
            !connected && h('p', { role: 'status' }, t('reconnecting')),
            attempt && h('div', { className: 'interaction', 'aria-live': 'polite' },
              h('strong', { 'data-testid': 'codex-login-attempt' }, t(attempt.state)),
              active(attempt) && h('p', { className: 'muted' }, `${t('remaining')}: ${Math.max(0, Math.ceil((attempt.deadline - now) / 1000))} ${t('seconds')}`),
              notice && h('p', null, notice.message),
              link && h('p', null, h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, t('open'))),
              notice?.code && h('p', null, `${t('code')}: `, h('code', null, notice.code)),
              attempt.error && h('p', { role: 'alert' }, t(attempt.error)),
              prompt && h('form', { onSubmit: event => { event.preventDefault(); void action('answer') } },
                h('label', null, prompt.message,
                  prompt.kind === 'select'
                    ? h('select', { value: answer, onChange: event => setAnswer(event.target.value), required: true },
                      h('option', { value: '', disabled: true }, '—'),
                      ...prompt.options.map(option => h('option', { key: option.id, value: option.id }, option.label)))
                    : h('input', { type: 'password', value: answer, onChange: event => setAnswer(event.target.value),
                      placeholder: prompt.placeholder, autoComplete: 'off', spellCheck: false, required: true, 'aria-label': t('input') })),
                h('button', { type: 'submit', disabled: pending || !answer.trim() }, t('answer')))),
            error && h('p', { role: 'alert' }, t(error)),
            confirmation && h('div', { className: 'interaction' },
              h('p', null, t(confirmation === 'begin' ? 'confirmLogin' : 'confirmSignOut')),
              h('div', { className: 'row' }, button('continue', () => void action(confirmation), pending, true), button('back', () => setConfirmation(null)))),
            h('div', { className: 'row' },
              button(status?.credential === 'grant' ? 'retry' : 'login', () => status?.credential === 'absent' ? void action('begin') : setConfirmation('begin'),
                pending || !status || status.busy || status.environment !== 'ready' || !status.writable, true),
              active(attempt) && button('cancel', () => void action('cancel'), pending),
              status?.credential !== 'absent' && status && button('signOut', () => setConfirmation('sign-out'), pending || !status.writable),
              button('refresh', () => { setError(null); void refresh() }, pending)),
            h('p', { className: 'muted' }, t('note')))
        }
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer', id: 'codex-login', order: 10,
        }, Panel))
      },
    }
  },
})
