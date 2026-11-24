import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, firefox } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'

declare global {
  interface Window {
    __DSH_WEB_HELLO__?: {
      factory: boolean; applied: boolean; registered: boolean; error: string | null; slot: string | null
      sessionId?: string
      openWorkspace(path: string): Promise<void>
    }
    __L5_NOTIFICATIONS__: {
      requests: number
      interactionsAtRequest: number[]
      calls: Array<{ title: string; body: string; tag: string; closed: boolean; data?: { id: string; sessionId: string } }>
    }
  }
}

const url = process.env['DSH_E2E_URL']
const artifacts = process.env['DSH_E2E_ARTIFACTS']
const mode = process.env['DSH_E2E_MODE']
const workspaceRoot = process.env['DSH_E2E_WORKSPACE']
assert.ok(url && artifacts && workspaceRoot && (mode === 'baseline' || mode === 'fixture'), 'run through node scripts/bootstrap.mjs l5')
mkdirSync(artifacts, { recursive: true })
const explicit = process.env['CHROME_PATH']
const useFirefox = process.env['DSH_E2E_BROWSER'] === 'firefox'
const downloaded = useFirefox || process.env['DSH_E2E_BROWSER'] === 'chromium'
const executablePath = downloaded ? undefined : explicit
const suiteTimeout = Number(process.env['DSH_E2E_TIMEOUT_MS'] ?? 120_000)
assert.ok(Number.isSafeInteger(suiteTimeout) && suiteTimeout > 0 && suiteTimeout <= 2_147_483_647, 'invalid browser suite timeout')
const results: Array<{ name: string; ok: boolean; error?: string }> = []
let browser: Browser | undefined
let deadline: NodeJS.Timeout | undefined
let currentCheck = 'browser-start'

/** Existing SSE/UI checks use the page fallback; worker registration is checked separately. */
async function stubNotifications(context: BrowserContext, denied = false, persistent = false): Promise<void> {
  await context.addInitScript(({ denied, persistent }) => {
    if (!persistent) Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined })
    const state: Window['__L5_NOTIFICATIONS__'] = { requests: 0, interactionsAtRequest: [], calls: [] }
    window.__L5_NOTIFICATIONS__ = state
    let interactions = 0
    window.addEventListener('pointerdown', () => { interactions++ }, true)
    window.addEventListener('keydown', () => { interactions++ }, true)
    let permission = 'default'
    class StubNotification {
      static get permission() { return permission }
      static async requestPermission() {
        state.requests++
        state.interactionsAtRequest.push(interactions)
        permission = denied ? 'denied' : 'granted'
        return permission
      }
      readonly record: Window['__L5_NOTIFICATIONS__']['calls'][number]
      constructor(title: string, options: NotificationOptions = {}) {
        this.record = { title, body: options.body ?? '', tag: options.tag ?? '', closed: false, data: options.data }
        state.calls.push(this.record)
      }
      close() { this.record.closed = true }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: StubNotification })
    // Init scripts also run on Chromium's initial about:blank, where the
    // secure-context-only worker API is absent. The DSH page must expose it.
    if (persistent && typeof ServiceWorkerRegistration !== 'undefined') {
      ServiceWorkerRegistration.prototype.showNotification = async function(title, options) { new StubNotification(title, options) }
      ServiceWorkerRegistration.prototype.getNotifications = async function(options) {
        return state.calls.filter(item => !item.closed && (!options?.tag || item.tag === options.tag)).map(item => ({
          data: item.data, close() { item.closed = true },
        })) as Notification[]
      }
    }
  }, { denied, persistent })
}

/** Fresh browser contexts, strict error gate, and diagnostics even when an assertion fails. */
async function check(name: string, body: (page: Page, context: BrowserContext, directory: string) => Promise<void>, denied = false, persistent = false): Promise<void> {
  currentCheck = name
  assert.ok(browser)
  const directory = join(artifacts!, name)
  mkdirSync(directory, { recursive: true })
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  const knownHostErrors: string[] = []
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  await stubNotifications(context, denied, persistent)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(30_000)
  const monitor = (page: Page): void => {
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    page.on('console', message => {
    if (message.type() !== 'error') return
    const location = message.location().url
    // DSH 0.2.1-rc.2 falls back to a generic glyph when native icon extraction
    // fails: Explorer on Windows, or Windows VS Code exposed in WSL without a
    // Linux desktop entry. Retain these exact 404s in diagnostics, not all 404s.
    const missingHostIcon = process.platform === 'win32' ? 'explorer'
      : process.platform === 'linux' ? 'vscode' : undefined
    if (missingHostIcon !== undefined
      && location === new URL(`/open-in-app/icon/${missingHostIcon}`, url).href
      && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)') {
      knownHostErrors.push(`${location}: ${message.text()}`)
    } else errors.push(`console: ${message.text()} (${location})`)
    })
  }
  monitor(page)
  context.on('page', monitor)
  try {
    await body(page, context, directory)
  } catch (error) {
    results.push({ name, ok: false, error: String(error) })
    throw error
  } finally {
    // Diagnose the original failure even if the page itself has crashed.
    const evidencePage = page.isClosed() ? context.pages().at(-1) ?? page : page
    writeFileSync(join(directory, 'aria.txt'), await evidencePage.locator('body').ariaSnapshot().catch(() => 'page unavailable'))
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify(await evidencePage.evaluate(() => window.__DSH_WEB_HELLO__ ?? null).catch(() => null), null, 2))
    await evidencePage.screenshot({ path: join(directory, 'page.png') }).catch(() => {})
    await context.tracing.stop({ path: join(directory, 'trace.zip') }).catch(() => {})
    await context.close()
    writeFileSync(join(directory, 'errors.json'), JSON.stringify(errors, null, 2))
    writeFileSync(join(directory, 'known-host-errors.json'), JSON.stringify(knownHostErrors, null, 2))
  }
  // Include errors arriving during screenshot/trace capture and context teardown.
  try {
    assert.deepEqual(errors, [], 'unexpected console/page errors (including slot crashes)')
  } catch (error) {
    results.push({ name, ok: false, error: String(error) })
    throw error
  }
  results.push({ name, ok: true })
  console.log(`PASS ${name}`)
}

async function open(page: Page, baseline: boolean): Promise<void> {
  await page.goto(url!, { waitUntil: 'domcontentloaded' })
  if (baseline) {
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('dialog', { name: 'Preview Notice' }).waitFor({ state: 'hidden' })
  } else {
    await page.waitForFunction(() => window.__DSH_WEB_HELLO__?.registered === true)
    // Check before dismissing onboarding or creating a session: permission is
    // requested by plugin activation, not by a notification or a user gesture.
    await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.requests === 1)
    // Playwright evaluation can itself set Chromium's userActivation flag;
    // count input events instead of treating that flag as proof of a gesture.
    assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.interactionsAtRequest), [0])
    assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls), [])
  }
  const login = page.getByRole('dialog', { name: /Get started|开始使用/ })
  const sessions = page.getByRole('tree', { name: /Sessions|会话/, exact: true })
  // The host may open directly into the session UI without a login dialog.
  await login.or(sessions).first().waitFor({ state: 'visible' })
  if (await login.isVisible()) {
    await login.getByRole('button', { name: /Close|关闭/, exact: true }).click()
    await login.waitFor({ state: 'hidden' })
  }
  await sessions.waitFor({ state: 'visible' })
}

/** Wait for the Host settings write before reloading or opening the next context. */
async function switchLocale(page: Page, language: 'en' | 'zh'): Promise<void> {
  const fixture = page.getByTestId('web-hello')
  const send = fixture.getByRole('button', { name: language === 'en' ? 'Send to Host' : '发送到主机', exact: true })
  if (await send.isVisible()) return
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/mutate' && response.request().method() === 'POST')
  await fixture.getByRole('button', { name: language === 'en' ? 'English' : '中文', exact: true }).click()
  const response = await saved
  assert.equal(response.status(), 200, 'locale preference did not persist')
  await response.finished()
  await send.waitFor({ state: 'visible' })
}

async function prepareFixture(page: Page, name: string, alreadyOpen = false): Promise<void> {
  if (!alreadyOpen) await open(page, false)
  const workspace = join(workspaceRoot!, name)
  mkdirSync(workspace, { recursive: true })
  // A restored session can already render the slot. Wait for THIS setup to
  // finish, rather than treating that previous session's DOM as readiness.
  await page.evaluate(path => window.__DSH_WEB_HELLO__!.openWorkspace(path), workspace)
  assert.equal(await page.evaluate(() => window.__DSH_WEB_HELLO__?.error), null, 'fixture setup failed')
  await page.getByTestId('web-hello').waitFor({ state: 'visible' })
  assert.equal(await page.getByTestId('web-hello').count(), 1)
  const state = await page.evaluate(() => window.__DSH_WEB_HELLO__!)
  assert.ok(state.sessionId, 'new fixture session was not created')
  assert.equal(state.factory, true)
  assert.equal(state.applied, true)
  assert.equal(state.registered, true)
  assert.equal(state.slot, 'conversation.composer.dock')
}

async function notify(page: Page, action: 'approval' | 'complete' | 'max-tokens' | 'withdraw' | 'question' | 'question-ptc' | 'question-timed' | 'question-release' | 'answer'): Promise<void> {
  const status = await page.evaluate(async action => {
    const response = await fetch(new URL('api/web-hello/notify', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, sessionId: window.__DSH_WEB_HELLO__!.sessionId }),
    })
    return { status: response.status, body: await response.text() }
  }, action)
  assert.equal(status.status, 200, `Host fixture ${action} failed: ${status.body}`)
}

async function answerQuestion(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'A', exact: true }).click()
  await page.getByRole('button', { name: /^(Submit|提交)$/ }).click()
  await notify(page, 'answer')
}

try {
  assert.ok(downloaded || (executablePath && existsSync(executablePath)), 'set CHROME_PATH, or install Chromium and set DSH_E2E_BROWSER=chromium')
  browser = await (useFirefox ? firefox : chromium).launch({ headless: true, executablePath, timeout: 30_000 })
  deadline = setTimeout(() => {
    results.push({ name: 'suite-deadline', ok: false, error: `browser suite exceeded ${suiteTimeout}ms` })
    process.exitCode = 1
    void browser?.close()
  }, suiteTimeout)
  if (mode === 'baseline') {
    await check('no-custom-plugins', async page => {
      await open(page, true)
      assert.equal(await page.evaluate(() => window.__DSH_WEB_HELLO__), undefined)
      await page.getByRole('tree', { name: 'Sessions', exact: true }).getByText('Default workspace', { exact: true }).waitFor()
      assert.equal(await page.getByText('Unable to create default workspace. Use Choose workspace to select a folder.', { exact: true }).count(), 0)
      await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor({ state: 'visible' })
    })
  } else {
    await check('notification-reopen-continues', async (page, context) => {
      await prepareFixture(page, 'persistent-before-close')
      assert.equal(await page.evaluate(() => typeof ServiceWorkerRegistration), 'function', 'persistent notification check requires the real worker API on the DSH page')
      await notify(page, 'complete')
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 1)
      const data = await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls[0]!.data!)
      await page.close()
      const reopened = await context.newPage()
      const target = new URL(url!)
      target.searchParams.set('notify-web-session', data.sessionId)
      target.searchParams.set('notify-web-id', data.id)
      await reopened.goto(target.href)
      await reopened.waitForFunction(() => (window as unknown as { __NOTIFY_WEB__?: { connected: boolean } }).__NOTIFY_WEB__?.connected === true)
      await prepareFixture(reopened, 'persistent-after-close', true)
      await notify(reopened, 'complete')
      await reopened.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 1)
      await notify(reopened, 'question')
      await notify(reopened, 'question-release')
      await reopened.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 2)
      await answerQuestion(reopened)
    }, false, true)
    await check('slot-interaction-theme-locale-reload', async (page, _context, directory) => {
      await prepareFixture(page, 'matrix')
      // Exercise the real authenticated worker route and browser activation;
      // OS click delivery remains a manual check, not simulated by this assertion.
      assert.equal(await page.evaluate(async () => {
        const container = Reflect.get(Object.getPrototypeOf(navigator), 'serviceWorker', navigator) as ServiceWorkerContainer
        const registration = await container.register(new URL('api/notify-web/worker.js', document.baseURI), { updateViaCache: 'none' })
        if (!registration.active) {
          const worker = registration.installing ?? registration.waiting
          if (!worker) throw new Error('worker not installed')
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (worker.state === 'activated') resolve()
              if (worker.state === 'redundant') reject(new Error('worker redundant'))
            }
            worker.addEventListener('statechange', changed)
            changed()
          })
        }
        return registration.scope === new URL('api/notify-web/', document.baseURI).href
      }), true)
      // Real authenticated SSE must connect and persist its initial cursor.
      await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
      assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls), [])
      let count = 0
      const colors: string[] = []
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        const fixture = page.getByTestId('web-hello')
        for (const locale of ['en', 'zh'] as const) {
          await switchLocale(page, locale)
          const send = fixture.getByRole('button', { name: locale === 'en' ? 'Send to Host' : '发送到主机', exact: true })
          await send.waitFor({ state: 'visible' })
          const text = `${theme}-${locale}-回声`
          await page.getByTestId('web-hello-input').fill(text)
          await send.click()
          await page.getByTestId('web-hello-result').getByText(`${text} #${++count}`, { exact: true }).waitFor({ state: 'visible' })
          await page.screenshot({ path: join(directory, `${theme}-${locale}.png`) })
        }
        colors.push(await fixture.evaluate(element => {
          const style = getComputedStyle(element)
          if (!style.getPropertyValue('--dsw-alias-label-primary').trim()) throw new Error('host theme token missing')
          return style.color
        }))
      }
      assert.notEqual(colors[0], colors[1], 'host theme did not change the fixture text color')
      await switchLocale(page, 'en')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByTestId('web-hello').waitFor({ state: 'visible' })
      assert.equal(await page.getByTestId('web-hello').count(), 1, 'reload duplicated the slot')
      await page.getByTestId('web-hello-input').fill('after-reload')
      await page.getByTestId('web-hello').getByRole('button', { name: 'Send to Host', exact: true }).click()
      await page.getByTestId('web-hello-result').getByText(`after-reload #${++count}`, { exact: true }).waitFor({ state: 'visible' })
    })

    await check('question-real-tool-sse', async (page, context) => {
      // Keep an old page's pre-question Web Lock held throughout this check.
      // A current client must still receive the real tool's notification.
      const legacy = await context.newPage()
      const legacyUrl = new URL('/l5-legacy-notification-client', url).href
      await legacy.route(legacyUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>Legacy lock fixture</title>' }))
      await legacy.goto(legacyUrl)
      await legacy.evaluate(() => new Promise<void>(resolve => {
        void navigator.locks.request('notify-web:/', async () => {
          resolve()
          await new Promise(() => {})
        })
      }))
      await prepareFixture(page, 'question-real-tool')
      await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
      await page.evaluate(() => { window.__L5_NOTIFICATIONS__.calls = [] })
      await notify(page, 'question')
      assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.length), 0, 'tool call before Remote delivery must not notify')
      await notify(page, 'question-release')
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.some(call => call.title === 'Reply needed'))
      const questions = await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed'))
      assert.equal(questions.length, 1)
      assert.equal(questions[0]?.body, 'Which option should we use?')
      await answerQuestion(page)
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed').every(call => call.closed))
      await legacy.close()
    })

    await check('question-ptc-received-sse', async page => {
      await prepareFixture(page, 'question-ptc-start')
      await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
      await page.evaluate(() => { window.__L5_NOTIFICATIONS__.calls = [] })
      await notify(page, 'question-ptc')
      assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.length), 0, 'PTC start before Remote delivery must not notify')
      await notify(page, 'question-release')
      // The child is blocked awaiting its answer, so no dispatch result exists yet.
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.some(call => call.title === 'Reply needed'))
      const calls = await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed'))
      assert.equal(calls.length, 1)
      assert.match(calls[0]!.tag, /:question:request-/)
      await answerQuestion(page)
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed').every(call => call.closed))
    })

    await check('question-leader-handover', async (page, context) => {
      await prepareFixture(page, 'question-handover')
      await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
      const sessionId = await page.evaluate(() => window.__DSH_WEB_HELLO__!.sessionId)
      assert.ok(sessionId)
      const follower = await context.newPage()
      await follower.goto(page.url(), { waitUntil: 'domcontentloaded' })
      await follower.waitForFunction(() => window.__L5_NOTIFICATIONS__.requests === 1)
      // The original page still receives the Remote request, but the second
      // page owns notifications. Receipt must cross that tab boundary.
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await follower.waitForFunction(() => (window as unknown as { __NOTIFY_WEB__?: { leader: boolean; connected: boolean } }).__NOTIFY_WEB__?.connected === true)
      await notify(page, 'question-timed')
      assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.length), 0)
      await notify(page, 'question-release')
      await follower.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.some(call => call.title === 'Reply needed'))
      assert.equal(await follower.evaluate(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed').length), 1)
      assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.length), 0, 'receipt observer must not duplicate the other tab leader')
      await follower.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.some(call => call.title === 'Reply needed'))
      await answerQuestion(page)
      await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.filter(call => call.title === 'Reply needed').every(call => call.closed))
      await follower.close()
    })

    for (const withGoal of [true, false]) {
      await check(withGoal ? 'completion-goal' : 'completion-subagents', async (page, _context, directory) => {
        await prepareFixture(page, withGoal ? 'completion-goal' : 'completion-subagents')
        await switchLocale(page, 'en')
        await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
        await page.evaluate(() => { window.__L5_NOTIFICATIONS__.calls = [] })
        interface State { sessionId: string; stage: string; status: string; goal: string | null; remaining: number; intermediateRounds: number }
        const evidence: State[] = []
        let sessionId: string | undefined
        const action = async (action: string, index?: number): Promise<State> => {
          const result = await page.evaluate(async body => {
            const response = await fetch(new URL('api/web-hello/completion', document.baseURI), {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            })
            return { status: response.status, text: await response.text() }
          }, { action, sessionId, index, withGoal })
          assert.equal(result.status, 200, result.text)
          return JSON.parse(result.text) as State
        }
        const checkpoint = async (predicate: (state: State) => boolean): Promise<State> => {
          const deadline = Date.now() + 15_000
          do {
            const state = await action('state')
            if (predicate(state)) { evidence.push(state); return state }
            await page.waitForTimeout(25)
          } while (Date.now() < deadline)
          throw new Error('controlled completion checkpoint timed out')
        }
        const silent = async (): Promise<void> => {
          // Observe real SSE beyond any microtask scheduling, not as a production delay.
          await page.waitForTimeout(150)
          assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls), [])
        }
        try {
          const initial = await action('start'); sessionId = initial.sessionId; evidence.push(initial)
          assert.equal(initial.remaining, 2)
          assert.equal(initial.status, 'idle')
          assert.equal(initial.goal, withGoal ? 'active' : null)
          await silent()
          await action('release', 0)
          await checkpoint(state => state.intermediateRounds > 0 && state.status === 'idle')
          await silent()
          await action('release', 1)
          const summarizing = await checkpoint(state => state.stage === 'summarizing')
          assert.equal(summarizing.goal, withGoal ? 'complete' : null)
          assert.equal(summarizing.status, 'running')
          await silent() // Marking the goal complete must not precede the final reply.
          evidence.push(await action('finish'))
          await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 1)
          const notifications = await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls)
          assert.equal(notifications[0]?.title, 'Turn completed')
          assert.ok(notifications[0]?.tag.startsWith(`dsh-turn-end:${sessionId}:turn-end:`))
          await page.waitForTimeout(150)
          assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls.length), 1)
          writeFileSync(join(directory, 'completion.json'), JSON.stringify({ evidence, notifications }, null, 2))
        } finally {
          if (sessionId) await action('dispose')
        }
      })
    }

    for (const language of ['en', 'zh', 'denied'] as const) {
      await check(`notification-${language}`, async page => {
        let streams = 0
        let asked = false
        let settled = false
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/api/notify-web/events') streams++
        })
        try {
          await prepareFixture(page, `notification-${language}`)
          const fixture = page.getByTestId('web-hello')
          await switchLocale(page, language === 'zh' ? 'zh' : 'en')
          await fixture.getByRole('button', { name: language === 'zh' ? '发送到主机' : 'Send to Host', exact: true }).waitFor({ state: 'visible' })
          if (language !== 'denied') {
            await page.waitForFunction(() => localStorage.getItem('notify-web:v3:cursor:/') !== null)
          }
          await page.evaluate(() => { window.__L5_NOTIFICATIONS__.calls = [] })
          await notify(page, 'approval')
          asked = true
          if (language === 'denied') {
            await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.requests === 1)
            assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.interactionsAtRequest), [0], 'permission request must precede user interaction')
            await notify(page, 'complete')
            // Observe beyond the Host's default 300ms approval delay.
            await page.waitForTimeout(600)
            assert.equal(streams, 0, 'denied permission must not open the notification stream')
            assert.deepEqual(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls), [])
          } else {
            await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 1)
            await notify(page, 'complete')
            await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 2)
            const calls = await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls)
            assert.deepEqual(calls.map(call => [call.title, call.body]), language === 'en' ? [
              ['Approval required', 'shell-test is requesting permission: L5 test'],
              ['Turn completed', 'The reply has finished; you can come back now.'],
            ] : [
              ['需要确认权限', 'shell-test 正在请求授权：L5 test'],
              ['对话已完成', '本轮回复已结束，可以回来查看了。'],
            ])
            assert.ok(streams >= 1)
            await notify(page, 'max-tokens')
            await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls.length === 3)
            assert.equal(await page.evaluate(() => window.__L5_NOTIFICATIONS__.calls[2]?.title),
              language === 'en' ? 'Output limit reached' : '本轮已达到输出上限')
            await notify(page, 'withdraw')
            settled = true
            await page.waitForFunction(() => window.__L5_NOTIFICATIONS__.calls[0]?.closed === true)
          }
          // Leave persisted host locale predictable for the next fresh context.
          await switchLocale(page, 'en')
        } finally {
          if (asked && !settled) await notify(page, 'withdraw')
        }
      }, language === 'denied')
    }
  }
} catch (error) {
  // Startup, context setup and teardown can fail before check() records a result.
  if (!results.some(result => !result.ok)) results.push({ name: currentCheck, ok: false, error: String(error) })
  throw error
} finally {
  clearTimeout(deadline)
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
  await browser?.close()
}
