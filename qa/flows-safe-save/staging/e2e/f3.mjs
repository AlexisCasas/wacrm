// F3 functional QA (safe save + activation gate) driven through a REAL browser against the isolated staging.
// Runs inside the f3-stg-app container. Database facts, fault injection and "other company" checks are asked of the host
// driver (staging/run-f3.sh) through small request/ack files in /qa/staging/state, so the browser never gets DB access.
import fs from 'node:fs'
import { chromium } from '/qa/staging/pw/node_modules/playwright-core/index.mjs'
const { URL, EMAIL_A, EMAIL_B, PASSWORD } = process.env
const STATE = '/qa/staging/state', SHOTS = '/qa/staging/shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`QA-RESULT ${id} ${ok ? 'PASS' : 'FAIL'} ${detail}`) }
let seq = 0
async function host(cmd) {
  const id = String(++seq).padStart(3, '0')
  fs.writeFileSync(`${STATE}/${id}.tmp`, cmd); fs.renameSync(`${STATE}/${id}.tmp`, `${STATE}/${id}.req`)
  for (let i = 0; i < 480; i++) { if (fs.existsSync(`${STATE}/${id}.ack`)) return fs.readFileSync(`${STATE}/${id}.ack`, 'utf8').trim(); await sleep(250) }
  throw new Error(`host call timed out: ${cmd}`)
}
const hostJson = async (cmd) => JSON.parse(await host(cmd))

const browser = await chromium.launch()
const newPage = async () => { const ctx = await browser.newContext({ viewport: { width: 1400, height: 1500 } }); return { ctx, page: await ctx.newPage() } }
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
async function login(page, email) {
  await page.goto(`${URL}/login`); await page.fill('input[type=email]', email); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })
}
const nameInput = (page) => page.locator('[aria-label="Flow name"], input[placeholder="Flow name"]').first()
const messageBox = (page) => page.locator('textarea').last()
const toasts = (page) => page.locator('[data-sonner-toast]').allTextContents()
const clearToasts = async (page) => { await page.waitForTimeout(300); for (const t of await page.locator('[data-sonner-toast]').all()) await t.click({ timeout: 500 }).catch(() => {}) }
const edited = (page) => page.getByText(/^edited$/i).first().isVisible().catch(() => false)
const status = async (page) => (await page.getByText(/^(draft|active|archived)$/i).first().textContent().catch(() => '?')).trim().toLowerCase()
async function pick(page, i, option) { await page.getByRole('combobox').nth(i).click(); await page.getByRole('option', { name: option, exact: true }).click(); await page.waitForTimeout(200) }
const settle = async (p) => { await p.waitForLoadState('load'); await p.waitForTimeout(1200) }
const stamp = Date.now().toString(36)
const FLOW_NAME = `Pilot QA draft ${stamp}`

// ------------------------------------------------------------------------------------------------ account A
const { page } = await newPage()
const requests = []
page.on('request', (r) => { const u = r.url(); if (u.includes('/api/flows')) requests.push({ method: r.method(), url: u.replace(URL, '') }) })
const count = (method, suffix) => requests.filter((r) => r.method === method && r.url.endsWith(suffix)).length
await login(page, EMAIL_A)
const ids = await hostJson('ids'); const otherBefore = await host(`hash-other`)
await host('fault off')

// F3-01 create a draft flow
await page.goto(`${URL}/flows`)
await page.getByRole('button', { name: 'New flow' }).first().click()
await page.getByRole('dialog').locator('input').first().fill(FLOW_NAME); await page.getByRole('button', { name: 'Create blank flow' }).click()
await page.waitForURL(/\/flows\/[0-9a-f-]{36}/, { timeout: 30000 })
const flowId = page.url().match(/\/flows\/([0-9a-f-]{36})/)[1]
let db = await hostJson(`flowdb ${flowId}`)
check('F3-01', db.name === FLOW_NAME && db.status === 'draft' && db.account_id === ids.account_a && (await status(page)) === 'draft',
  `flow created from the UI: DB name="${db.name}", status=${db.status}, belongs to account A; badge shows Draft`)
await shot(page, 'f3-01-created')

// F3-02 several nodes and connections, then save
await page.getByRole('button', { name: 'List' }).click()
const add = async (n) => { await page.getByRole('button', { name: 'Add node' }).click(); await page.getByRole('menuitem', { name: new RegExp('^' + n) }).click(); await page.waitForTimeout(250) }
await add('Start'); await add('Send message'); await add('End')
await page.getByPlaceholder('support, help, hi').fill('hola, pilot')
await pick(page, 2, 'send_message'); await messageBox(page).fill('Hola desde Pilot QA (v1)'); await pick(page, 3, 'end')
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
const t1 = await toasts(page); db = await hostJson(`flowdb ${flowId}`)
const keys = db.nodes.map((n) => n.node_key).sort().join(',')
const startNode = db.nodes.find((n) => n.node_key === 'start'), msgNode = db.nodes.find((n) => n.node_key === 'send_message')
check('F3-02', t1.some((t) => /saved/i.test(t)) && keys === 'end,send_message,start' && startNode.config.next_node_key === 'send_message' && msgNode.config.next_node_key === 'end' && msgNode.config.text === 'Hola desde Pilot QA (v1)' && db.entry_node_id === 'start' && !(await edited(page)),
  `3 nodes (${keys}) and their connections start->send_message->end persisted, text saved, entry=${db.entry_node_id}, "Saved." toast, pending badge cleared`)
await shot(page, 'f3-02-saved')

// F3-03 modify, save, reload, recover
await nameInput(page).fill(`${FLOW_NAME} v2`); await messageBox(page).fill('Hola desde Pilot QA (v2)')
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
await page.reload(); await settle(page); await page.getByRole('button', { name: 'List' }).click().catch(() => {})
db = await hostJson(`flowdb ${flowId}`)
const uiName = await nameInput(page).inputValue(); const uiText = await messageBox(page).inputValue()
check('F3-03', uiName === `${FLOW_NAME} v2` && uiText === 'Hola desde Pilot QA (v2)' && db.name === uiName && db.nodes.find((n) => n.node_key === 'send_message').config.text === uiText,
  `after Save + page reload the editor shows the v2 name and text and the database holds the same values`)
await host(`snap v2 ${flowId}`)

// ---------------------------------------------------------------------------------- failure with a REAL database fault
await host('fault on')
await nameInput(page).fill(`${FLOW_NAME} v3 MUST-NOT-PERSIST`); await messageBox(page).fill('Hola desde Pilot QA (v3 MUST-NOT-PERSIST)')
await clearToasts(page)
const putBefore = count('PUT', `/api/flows/${flowId}`)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1800)
const tFail = await toasts(page)
check('F3-04', (await host(`same v2 ${flowId}`)) === 'same',
  `with an injected failure while the nodes are inserted (header already updated inside the transaction), the database still holds EXACTLY the v2 flow: same header (incl. updated_at), same node ids, configs and connections`)
const stillVisible = (await nameInput(page).inputValue()).includes('MUST-NOT-PERSIST') && (await messageBox(page).inputValue()).includes('MUST-NOT-PERSIST')
check('F3-05', count('PUT', `/api/flows/${flowId}`) === putBefore + 1 && tFail.length === 1 && /could not save|nothing was saved|not valid/i.test(tFail[0]) && !tFail.some((t) => /^saved/i.test(t)) && (await edited(page)) && stillVisible && (await status(page)) === 'draft',
  `Save failed: exactly one error toast ("${tFail[0] ?? ''}"), no success message, the EDITED badge stays, the v3 edits are still on screen`)
await shot(page, 'f3-05-error-shown')

// F3-06 activation after a failed save
await clearToasts(page)
const activateBefore = count('POST', `/api/flows/${flowId}/activate`), putBefore2 = count('PUT', `/api/flows/${flowId}`)
await page.getByRole('button', { name: 'Activate' }).click(); await page.waitForTimeout(2200)
const tAct = await toasts(page)
check('F3-06', count('PUT', `/api/flows/${flowId}`) === putBefore2 + 1 && count('POST', `/api/flows/${flowId}/activate`) === activateBefore && (await host(`same v2 ${flowId}`)) === 'same' && (await status(page)) === 'draft' && tAct.length === 1 && (await edited(page)),
  `Activate with a failing save: the save was attempted once, POST /activate was NEVER sent, the flow stays Draft with the v2 data in the database, one error toast ("${tAct[0] ?? ''}") and the edits remain pending`)
await shot(page, 'f3-06-activate-blocked')

// the same two behaviours with the request failing at the HTTP level (no database involved), via browser interception
await host('fault off')
await page.route('**/api/flows/*', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service temporarily unavailable' }) }) : route.continue()))
await clearToasts(page); const putA = count('PUT', `/api/flows/${flowId}`)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500); const tI = await toasts(page)
await clearToasts(page); const actA = count('POST', `/api/flows/${flowId}/activate`)
await page.getByRole('button', { name: 'Activate' }).click(); await page.waitForTimeout(2000)
check('F3-05b', tI.length === 1 && /temporarily unavailable/i.test(tI[0]) && (await edited(page)) && count('PUT', `/api/flows/${flowId}`) === putA + 2 && count('POST', `/api/flows/${flowId}/activate`) === actA && (await host(`same v2 ${flowId}`)) === 'same',
  `HTTP-level failure (intercepted 503): error shown ("${tI[0] ?? ''}"), edits kept, /activate not sent, database untouched`)
await page.unroute('**/api/flows/*')

// F3-07 service restored, retry
await clearToasts(page)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1800)
const tOk = await toasts(page); db = await hostJson(`flowdb ${flowId}`)
check('F3-07', tOk.some((t) => /saved/i.test(t)) && !(await edited(page)) && db.name === `${FLOW_NAME} v3 MUST-NOT-PERSIST` && db.nodes.find((n) => n.node_key === 'send_message').config.text.includes('v3') && db.nodes.length === 3,
  `after the service is restored the SAME pending edits are saved with one click: "Saved." toast, pending badge cleared, database now holds the v3 name/text and still 3 nodes`)
await shot(page, 'f3-07-retry-saved')
const nameAfter = db.name; const textAfter = db.nodes.find((n) => n.node_key === 'send_message').config.text

// F3-08 sign out and back in
await page.locator('button').filter({ hasText: 'QA Owner A' }).first().click(); await page.getByRole('menuitem', { name: 'Sign out' }).click()
await page.waitForURL(/\/login/, { timeout: 30000 })
await login(page, EMAIL_A); await page.goto(`${URL}/flows/${flowId}`); await settle(page); await page.getByRole('button', { name: 'List' }).click().catch(() => {})
check('F3-08', (await nameInput(page).inputValue()) === nameAfter && (await messageBox(page).inputValue()) === textAfter && !(await edited(page)),
  `signed out (redirect to /login), signed in again and reopened the flow: name and message text are the saved v3 values`)
await shot(page, 'f3-08-after-relogin')

// F3-09 still a draft, nothing activated
db = await hostJson(`flowdb ${flowId}`); const counts = await hostJson('counts')
check('F3-09', db.status === 'draft' && (await status(page)) === 'draft' && counts.active_flows === 0 && counts.flow_runs === 0 && count('POST', `/api/flows/${flowId}/activate`) === 0,
  `the flow is still a draft in the database and in the UI; account A has ${counts.active_flows} active flows and ${counts.flow_runs} flow runs; no request ever reached /activate`)

// F3-10 isolation
const other = ids.flow_b
const probe = await page.evaluate(async ({ other, accountB }) => {
  const j = (r) => r.json().catch(() => ({}))
  const put = await fetch(`/api/flows/${other}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HIJACKED', nodes: [] }) })
  const get = await fetch(`/api/flows/${other}`); const del = await fetch(`/api/flows/${other}`, { method: 'DELETE' })
  const mine = await fetch(location.pathname.replace('/flows/', '/api/flows/'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'smuggle', account_id: accountB, user_id: 'x' }) })
  return { put: put.status, get: get.status, del: del.status, mine: mine.status, putBody: await j(put) }
}, { other, accountB: ids.account_b })
const otherAfter = await host('hash-other'); db = await hostJson(`flowdb ${flowId}`)
await page.goto(`${URL}/flows`); await settle(page); const listText = await page.locator('main').innerText().catch(() => '')
check('F3-10', probe.put === 404 && probe.get === 404 && probe.del === 404 && otherAfter === otherBefore && probe.mine === 200 && db.account_id === ids.account_a && db.description === 'smuggle' && !listText.includes('OTHER COMPANY'),
  `account A cannot write, read or delete company B's flow (PUT/GET/DELETE -> ${probe.put}/${probe.get}/${probe.del}); B's flow is byte-identical afterwards; a body carrying account_id/user_id of B is ignored (own flow stays in account A); B's flow is not listed for A`)
await shot(page, 'f3-10-list-a')

// account B sees only its own flow
const b = await newPage(); await login(b.page, EMAIL_B); await b.page.goto(`${URL}/flows`); await settle(b.page)
const listB = await b.page.locator('main').innerText().catch(() => '')
check('F3-10b', listB.includes('OTHER COMPANY') && !listB.includes('Pilot QA draft'), `account B's own list shows its flow and none of account A's flows`)
await shot(b.page, 'f3-10-list-b')

fs.writeFileSync(`${STATE}/results.json`, JSON.stringify(results, null, 2))
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
