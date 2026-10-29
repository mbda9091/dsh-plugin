import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
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
      calls: Array<{ title: string; body: string; tag: string; closed: boolean }>
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
const downloaded = process.env['DSH_E2E_BROWSER'] === 'chromium'
const executablePath = downloaded ? undefined : explicit
const suiteTimeout = Number(process.env['DSH_E2E_TIMEOUT_MS'] ?? 120_000)
assert.ok(Number.isSafeInteger(suiteTimeout) && suiteTimeout > 0 && suiteTimeout <= 2_147_483_647, 'invalid browser suite timeout')
const results: Array<{ name: string; ok: boolean; error?: string }> = []
let browser: Browser | undefined
let deadline: NodeJS.Timeout | undefined
let currentCheck = 'browser-start'

/** Replace only the OS notification API; the real client plugin still runs. */
async function stubNotifications(context: BrowserContext, denied = false): Promise<void> {
  await context.addInitScript(({ denied }) => {
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
        this.record = { title, body: options.body ?? '', tag: options.tag ?? '', closed: false }
        state.calls.push(this.record)
      }
      close() { this.record.closed = true }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: StubNotification })
  }, { denied })
}

/** Fresh browser contexts, strict error gate, and diagnostics even when an assertion fails. */
async function check(name: string, body: (page: Page, context: BrowserContext, directory: string) => Promise<void>, denied = false): Promise<void> {
  currentCheck = name
  assert.ok(browser)
  const directory = join(artifacts!, name)
  mkdirSync(directory, { recursive: true })
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  const knownHostErrors: string[] = []
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  await stubNotifications(context, denied)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(30_000)
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const location = message.location().url
    // DSH 0.2.1-rc.2 on Windows requests a missing Explorer icon after selecting
    // a session. Keep this exact upstream defect visible; no blanket 404 filter.
    if (process.platform === 'win32'
      && location === new URL('/open-in-app/icon/explorer', url).href
      && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)') {
      knownHostErrors.push(`${location}: ${message.text()}`)
    } else errors.push(`console: ${message.text()} (${location})`)
  })
  try {
    await body(page, context, directory)
  } catch (error) {
    results.push({ name, ok: false, error: String(error) })
    throw error
  } finally {
    // Diagnose the original failure even if the page itself has crashed.
    writeFileSync(join(directory, 'aria.txt'), await page.locator('body').ariaSnapshot().catch(() => 'page unavailable'))
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify(await page.evaluate(() => window.__DSH_WEB_HELLO__ ?? null).catch(() => null), null, 2))
    await page.screenshot({ path: join(directory, 'page.png') }).catch(() => {})
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
  await page.getByRole('dialog', { name: /Get started|开始使用/ }).getByRole('button', { name: /Close|关闭/, exact: true }).click()
  await page.getByRole('tree', { name: /Sessions|会话/, exact: true }).waitFor({ state: 'visible' })
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

async function prepareFixture(page: Page, name: string): Promise<void> {
  await open(page, false)
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

async function notify(page: Page, action: 'approval' | 'complete' | 'withdraw'): Promise<void> {
  const status = await page.evaluate(async action => {
    const response = await fetch(new URL('api/web-hello/notify', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, sessionId: window.__DSH_WEB_HELLO__!.sessionId }),
    })
    await response.text()
    return response.status
  }, action)
  assert.equal(status, 200, `Host fixture ${action} failed`)
}

try {
  assert.ok(downloaded || (executablePath && existsSync(executablePath)), 'set CHROME_PATH, or install Chromium and set DSH_E2E_BROWSER=chromium')
  browser = await chromium.launch({ headless: true, executablePath, timeout: 30_000 })
  deadline = setTimeout(() => {
    results.push({ name: 'suite-deadline', ok: false, error: `browser suite exceeded ${suiteTimeout}ms` })
    process.exitCode = 1
    void browser?.close()
  }, suiteTimeout)
  if (mode === 'baseline') {
    await check('no-custom-plugins', async page => {
      await open(page, true)
      assert.equal(await page.evaluate(() => window.__DSH_WEB_HELLO__), undefined)
      await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor({ state: 'visible' })
    })
  } else {
    await check('slot-interaction-theme-locale-reload', async (page, _context, directory) => {
      await prepareFixture(page, 'matrix')
      // Real authenticated SSE must connect and persist its initial cursor.
      await page.waitForFunction(() => localStorage.getItem('notify-web:cursor:/') !== null)
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
            await page.waitForFunction(() => localStorage.getItem('notify-web:cursor:/') !== null)
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
