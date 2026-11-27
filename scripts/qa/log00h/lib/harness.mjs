// Tiny test runner on top of the Playwright library: one result per matrix row, with its evidence (requests sent by the browser,
// database snapshots before and after, screenshots). Request headers are never recorded.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'

import { chromium } from 'playwright'

import { loadWorld, snapshot } from './world.mjs'

export const APP = process.env.APP_URL
if (APP !== 'http://127.0.0.1:3000') throw new Error(`refusing to run against ${APP}`)
export const RESULTS = process.env.QA_RESULTS

export async function until(condition, what, ms = 20_000) {
  const end = Date.now() + ms
  let last
  for (;;) {
    try {
      if (await condition()) return
    } catch (error) {
      last = error
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message.split('\n')[0]})` : ''}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export class Runner {
  constructor() {
    this.world = loadWorld()
    this.results = []
    this.contexts = new Map()
    mkdirSync(`${RESULTS}/shots`, { recursive: true })
    mkdirSync(`${RESULTS}/evidence`, { recursive: true })
  }

  async start() {
    this.browser = await chromium.launch()
  }
  async stop() {
    await this.browser?.close()
  }

  async context(userKey) {
    if (this.contexts.has(userKey)) return this.contexts.get(userKey)
    const user = this.world.users[userKey]
    const context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })
    context.setDefaultTimeout(20_000)
    const page = await context.newPage()
    try {
      await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
      await page.locator('#email').fill(user.email)
      await page.locator('#password').fill(user.password)
      await page.locator('button[type="submit"]').click()
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 })
    } catch {
      // never surface the raw browser log of a login: it echoes the password typed
      await context.close()
      throw Object.assign(new Error(`login failed for ${userKey}`), { blocked: true })
    }
    await page.close()
    this.contexts.set(userKey, context)
    return context
  }

  /** One matrix row. `body` returns the observed behaviour as text; it throws on a failed expectation. */
  async test(id, { user, title, expected }, body) {
    const t = new Test(this, id)
    const result = { id, user, title, expected, observed: '', status: 'PASS', notes: [] }
    let timer
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test exceeded 150 s')), 150_000) })
      result.observed = (await Promise.race([body(t), timeout])) ?? 'Como se esperaba'
      if (t.status) result.status = t.status
    } catch (error) {
      result.status = error.blocked ? 'BLOQUEADA' : 'FAIL'
      result.observed = String(error.message ?? error).slice(0, 1500)
    } finally {
      clearTimeout(timer)
    }
    result.notes = t.notes
    await t.finish(result)
    this.results.push(result)
    // written after every row: a run cut short still reports what it did
    writeFileSync(`${RESULTS}/tests.json`, JSON.stringify(this.results, null, 2))
    console.log(`${result.status.padEnd(9)} ${id} ${title}${result.status === 'PASS' ? '' : `\n          ${result.observed.split('\n').slice(0, 6).join('\n          ')}`}`)
  }
}

class Test {
  constructor(runner, id) {
    this.runner = runner
    this.id = id
    this.pages = []
    this.requests = []
    this.watched = new Map()
    this.notes = []
    this.status = null
  }
  get world() {
    return this.runner.world
  }
  note(text) {
    this.notes.push(text)
  }
  finding(text) {
    this.status = 'HALLAZGO'
    this.note(text)
  }
  notApplicable(text) {
    this.status = 'NA'
    this.note(text)
  }
  /** Preparation that is not the thing under test: if it fails the row is BLOQUEADA, not FAIL. */
  async setup(fn) {
    try {
      return await fn()
    } catch (error) {
      throw Object.assign(new Error(`preparation failed: ${error.message}`), { blocked: true })
    }
  }
  async page(userKey) {
    const context = await this.runner.context(userKey)
    const page = await context.newPage()
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() !== 'POST' || !url.pathname.startsWith('/api/')) return
      let body = null
      try {
        body = request.postDataJSON()
      } catch {
        body = null
      }
      const entry = { user: userKey, path: url.pathname, body, status: null }
      this.requests.push(entry)
      request.response().then((r) => { entry.status = r?.status() ?? null }, () => {})
    })
    this.pages.push(page)
    return page
  }
  posts(fragment) {
    return this.requests.filter((r) => r.path.includes(fragment))
  }
  /** Bodies sent to the payments endpoint, in order. */
  paymentPosts() {
    return this.posts('/api/orders/payments/orders/').map((r) => r.body)
  }
  async api(userKey, method, path, data) {
    const context = await this.runner.context(userKey)
    for (let attempt = 0; ; attempt += 1) {
      const response = await context.request.fetch(`${APP}${path}`, { method, ...(data ? { data } : {}), maxRedirects: 0 })
      if (response.status() === 429 && attempt === 0) {
        await pause(Math.min(Number(response.headers()['retry-after'] ?? 60), 65) * 1000)
        continue
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      this.requests.push({ user: userKey, path, via: 'api', method, body: data ?? null, status: response.status() })
      return { status: response.status(), body }
    }
  }
  async watch(label, orderId) {
    const before = await snapshot(orderId)
    this.watched.set(label, { orderId, before })
    return before
  }
  async after(label) {
    const entry = this.watched.get(label)
    assert.ok(entry, `order ${label} is not being watched`)
    entry.after = await snapshot(entry.orderId)
    return entry.after
  }
  async finish(result) {
    for (const entry of this.watched.values()) {
      if (!entry.after) entry.after = await snapshot(entry.orderId).catch(() => null)
    }
    const shots = []
    let n = 0
    for (const page of this.pages) {
      const file = `shots/${this.id}-${(n += 1)}.png`
      try {
        await page.screenshot({ path: `${RESULTS}/${file}` })
        shots.push(file)
      } catch {
        /* a closed page has no screenshot */
      }
      await page.close().catch(() => {})
    }
    result.screenshots = shots
    writeFileSync(`${RESULTS}/evidence/${this.id}.json`, JSON.stringify({ ...result, requests: this.requests, orders: Object.fromEntries(this.watched) }, null, 2))
  }
}
