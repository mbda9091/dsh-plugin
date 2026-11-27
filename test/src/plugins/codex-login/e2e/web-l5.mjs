import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, firefox } from 'playwright-core'

// Runs only against the owned L5 profile. No real account authorization or trace.
const url = process.env.DSH_E2E_URL
const directory = process.env.DSH_E2E_ARTIFACTS
const mode = process.env.DSH_E2E_MODE
assert.ok(url && directory && ['baseline', 'fixture'].includes(mode))
mkdirSync(directory, { recursive: true })
const browser = await (process.env.DSH_E2E_BROWSER === 'firefox' ? firefox : chromium).launch({
  headless: true, executablePath: process.env.CHROME_PATH || undefined,
})
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' })
const page = await context.newPage()
page.setDefaultTimeout(15_000)
const errors = []
const checks = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error' && !message.location().url.includes('/open-in-app/icon/')) errors.push(message.text()) })
async function models() {
  if (!await page.getByRole('dialog', { name: /^(Settings|设置)$/ }).isVisible()) {
    await page.getByRole('button', { name: /^(Account menu|账号菜单|账户菜单)$/ }).click()
    await page.getByRole('menuitem', { name: /Settings|设置/ }).click()
  }
  await page.getByRole('button', { name: /^(Models|模型)$/ }).click()
}
async function language(value) {
  await page.getByRole('button', { name: /^(General|通用设置)$/ }).click()
  const row = page.getByText(/^(Language|语言)$/).locator('..').locator('..')
  await row.getByRole('button').click()
  await page.getByRole('menuitem', { name: value === 'en' ? 'English' : '中文', exact: true }).click()
  await models()
}
async function nativeStatus() {
  return page.evaluate(async () => {
    const response = await fetch(new URL('api/codex-login/status', document.baseURI))
    return { code: response.status, data: await response.json() }
  })
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const notice = page.getByRole('dialog', { name: 'Preview Notice' })
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  const onboarding = page.getByRole('dialog', { name: /Get started|开始使用/ })
  await onboarding.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: /^(Close|关闭)$/ }).click()
  await models()
  if (mode === 'baseline') {
    assert.equal(await page.getByTestId('codex-login').count(), 0)
    checks.push('independent-baseline-no-panel')
  } else {
    const panel = page.getByTestId('codex-login')
    await panel.waitFor()
    assert.equal(await panel.count(), 1)
    const status = await nativeStatus()
    assert.equal(status.code, 200)
    assert.equal(status.data.credential, 'absent')
    assert.equal(status.data.environment, 'route-missing')
    const deniedUrl = new URL('api/codex-login/status', url)
    const denied = await fetch(deniedUrl, { headers: { origin: deniedUrl.origin } })
    assert.ok([401, 403].includes(denied.status))
    checks.push('native-flow-status-and-authentication')

    // Materialize {} using the actual Models editor, without a key or YAML edit.
    await page.getByRole('button', { name: /^(Add model provider|添加模型提供商)$/ }).click()
    await page.getByRole('combobox', { name: /^(Provider|提供商)$/ }).selectOption('openai-codex')
    await page.getByRole('button', { name: /^(Apply|保存)$/ , exact: true }).click()
    await panel.getByTestId('codex-login-environment').filter({ hasText: /Native subscription route enabled|原生订阅路由已启用/ }).waitFor()
    assert.equal((await nativeStatus()).data.environment, 'ready')
    checks.push('native-keyless-route-saved-through-model-settings')

    const colors = []
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      for (const locale of ['en', 'zh']) {
        await language(locale)
        await panel.getByRole('button', { name: locale === 'en' ? 'Sign in with ChatGPT' : '登录 ChatGPT', exact: true }).waitFor()
        await panel.screenshot({ path: join(directory, `${theme}-${locale}.png`) })
        const appearance = await panel.evaluate(element => {
          const style = getComputedStyle(element)
          return { color: style.color, border: style.getPropertyValue('--dsw-alias-settings-card-stroke').trim() }
        })
        assert.ok(appearance.border, 'host border token unavailable')
        if (locale === 'en') colors.push(appearance.color)
      }
    }
    assert.notEqual(colors[0], colors[1], 'panel did not follow host theme')
    checks.push('native-slot-light-dark-en-zh')
    await language('en')

    // Synthetic transport verifies presentation/inputs only. It never runs OAuth
    // or writes a grant. Native AuthorizationService interactions have L3 tests.
    let revision = (await nativeStatus()).data.revision + 100
    let state = 'running'
    let credential = 'absent'
    let step = 0
    let begins = 0
    let prompts = []
    let epoch = status.data.epoch
    let holdBegin = false
    let releaseBegin
    const attemptId = 'synthetic-attempt'
    const view = () => ({
      epoch, revision, attemptId, state, deadline: Date.now() + 600_000,
      ...(['running', 'waiting'].includes(state) ? {
        notice: { message: '<img src=x onerror=alert(1)> synthetic text', url: 'https://example.org/authorize', code: 'SYNTHETIC-CODE' },
        prompt: step === 0 ? { id: 'select', kind: 'select', message: 'Synthetic login method', options: [{ id: 'browser', label: 'Browser' }] }
          : { id: 'text', kind: 'text', message: 'Synthetic callback URL' },
      } : {}),
    })
    await page.route('**/api/codex-login/**', async route => {
      const request = route.request()
      const operation = new URL(request.url()).pathname.split('/').at(-1)
      const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data), headers: { 'cache-control': 'no-store' } })
      if (operation === 'status') return json({ epoch, revision, environment: 'ready', credential, writable: true, busy: state === 'waiting' })
      if (operation === 'begin') {
        begins++; state = 'waiting'; step = 0; revision++
        if (holdBegin) await new Promise(resolve => { releaseBegin = resolve })
        return json({ attemptId })
      }
      if (operation === 'events') {
        const privateStream = new URL(request.url()).searchParams.has('attemptId')
        return route.fulfill({ contentType: 'text/event-stream', body: `event: state\ndata: ${JSON.stringify(privateStream ? view() : { epoch, changed: true })}\n\n` })
      }
      if (operation === 'answer') {
        prompts.push(request.postDataJSON())
        step++; revision++
        if (step === 2) { state = 'authorized'; credential = 'grant' }
        return json({ ok: true })
      }
      if (operation === 'cancel') { state = 'cancelled'; revision++; return json({ ok: true }) }
      if (operation === 'sign-out') { credential = 'absent'; state = 'cancelled'; revision++; return json({ ok: true }) }
      throw new Error(`unexpected synthetic operation ${operation}`)
    })
    await panel.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click()
    await panel.getByText('SYNTHETIC-CODE', { exact: true }).waitFor()
    assert.equal(await panel.locator('img').count(), 0, 'native text was interpreted as HTML')
    await panel.screenshot({ path: join(directory, 'synthetic-device-prompt.png') })
    await panel.getByRole('combobox').selectOption('browser')
    await panel.getByRole('button', { name: 'Submit answer', exact: true }).click()
    // Password inputs are intentionally masked even when the host calls them text.
    const masked = panel.locator('input[aria-label="Authorization answer"]')
    await masked.waitFor()
    assert.equal(await masked.getAttribute('type'), 'password')
    await masked.fill('SYNTHETIC_CALLBACK')
    await panel.getByRole('button', { name: 'Submit answer', exact: true }).click()
    await panel.getByTestId('codex-login-attempt').filter({ hasText: 'This authorization was saved' }).waitFor()
    assert.equal(await panel.getByText('SYNTHETIC-CODE', { exact: true }).count(), 0)
    assert.equal(begins, 1)
    assert.deepEqual(prompts.map(p => [p.promptId, p.value]), [['select', 'browser'], ['text', 'SYNTHETIC_CALLBACK']])
    assert.ok(!await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })).then(text => text.includes('SYNTHETIC')))
    await panel.getByRole('button', { name: 'Sign out locally', exact: true }).click()
    await panel.getByText(/Other profiles in the same DSH home/).waitFor()
    await panel.getByRole('button', { name: 'Continue', exact: true }).click()
    await panel.getByTestId('codex-login-credential').filter({ hasText: 'No saved authorization' }).waitFor()
    checks.push('synthetic-select-text-device-code-sign-out-and-sensitive-cleanup')
    holdBegin = true
    const beginRequested = page.waitForRequest(request => request.url().endsWith('/api/codex-login/begin'))
    await panel.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click()
    await beginRequested
    assert.ok(releaseBegin, 'begin was not held')
    epoch = 'synthetic-replacement-host'
    state = 'cancelled'
    revision++
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/codex-login/status'))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await refreshed
    releaseBegin()
    await panel.getByRole('alert').filter({ hasText: 'The host reloaded' }).waitFor()
    assert.equal(await panel.getByTestId('codex-login-attempt').count(), 0)
    checks.push('synthetic-old-host-begin-response-rejected')
    await page.unroute('**/api/codex-login/**')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await models()
    await panel.waitFor()
    assert.equal(await panel.count(), 1)
    assert.equal((await nativeStatus()).data.credential, 'absent', 'synthetic UI test changed native credentials')
    checks.push('reload-single-panel-native-credentials-unchanged')
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ passed: true, mode, checks }, null, 2))
  console.log(`PASS codex-login ${mode}: ${checks.join(', ')}`)
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {})
  writeFileSync(join(directory, 'aria.txt'), await page.locator('body').ariaSnapshot().catch(() => 'page unavailable'))
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ passed: false, mode, checks, errors }, null, 2))
  throw error
} finally {
  await context.close()
  await browser.close()
}
