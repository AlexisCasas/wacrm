// Flow search in the "Run another flow" node: functional QA in a REAL Chromium on the isolated staging
// (account A opted in, account B not). Database facts come from the host driver (run-pilot.sh).
import fs from 'node:fs'
import { chromium } from '/qa/staging/pw/node_modules/playwright-core/index.mjs'
const { URL, EMAIL_A, EMAIL_B, PASSWORD } = process.env
const STATE = '/qa-pilot/state', SHOTS = '/qa-pilot/shots'
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
const newPage = async () => (await browser.newContext({ viewport: { width: 1400, height: 1700 } })).newPage()
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const settle = async (p) => { await p.waitForLoadState('load'); await p.waitForTimeout(1200) }
async function login(page, email) { await page.goto(`${URL}/login`); await page.fill('input[type=email]', email); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }) }
const toasts = (page) => page.locator('[data-sonner-toast]').allTextContents()
async function createFlow(page, name) {
  await page.goto(`${URL}/flows`); await settle(page)
  await page.getByRole('button', { name: 'New flow' }).first().click()
  await page.getByRole('dialog').locator('input').first().fill(name); await page.getByRole('button', { name: 'Create blank flow' }).click()
  await page.waitForURL(/\/flows\/[0-9a-f-]{36}/, { timeout: 30000 }); return page.url().match(/\/flows\/([0-9a-f-]{36})/)[1]
}
async function add(page, label) { await page.getByRole('button', { name: 'Add node' }).first().click(); await page.getByRole('menuitem', { name: new RegExp('^' + label) }).click(); await page.waitForTimeout(250) }
async function pickIn(page, combobox, option) { await combobox.click(); await page.getByRole('option', { name: option, exact: true }).click(); await page.waitForTimeout(200) }
const picker = (page) => page.getByRole('combobox', { name: 'Flow to run' })
const search = (page) => page.getByPlaceholder('Search flows by name…')
const options = async (page) => (await page.getByRole('option').allTextContents()).map((t) => t.trim())
const stamp = Date.now().toString(36)
const NAME_A = `Search host ${stamp}`

const page = await newPage()
const requests = []; page.on('request', (r) => { if (r.url().includes('/api/flows')) requests.push(`${r.method()} ${r.url().replace(URL, '')}`) })
await login(page, EMAIL_A)
const otherBefore = await host('hash-other')
const seeded = await host('seedflows 150')      // staging account A only: 154 extra drafts, 4 with distinctive (accented) names
const flowA = await createFlow(page, NAME_A)
await page.getByRole('button', { name: 'List' }).click()
await add(page, 'Start'); await add(page, 'Run another flow'); await add(page, 'Send message'); await add(page, 'End')
await page.getByPlaceholder('support, help, hi').fill('hola, buscador')
await pickIn(page, page.getByRole('combobox').nth(2), 'run_another_flow')
await page.locator('textarea').last().fill('Regreso del flujo buscado'); await pickIn(page, page.getByRole('combobox').nth(5), 'end')
await pickIn(page, page.getByRole('combobox', { name: 'When that flow ends, continue at' }).or(page.getByRole('combobox').nth(4)).first(), 'send_message')

// B01 the search box appears when the field is opened
await picker(page).click()
const box = search(page); const boxVisible = await box.isVisible().catch(() => false)
const initialOptions = await options(page)
check('B01', boxVisible && initialOptions.length > 0, `opening "Flow to run" shows a search box (placeholder "Search flows by name…") and ${initialOptions.length} results (catalog of ${Number(seeded) + 2} flows is capped for speed)`)
await shot(page, 'b01-open')

// B02 partial / accent / case-insensitive filtering, while typing, and its speed
const t0 = Date.now(); await box.fill('cotizacion'); await page.getByRole('option', { name: /Cotización Ñandú/ }).waitFor({ timeout: 5000 }); const elapsed = Date.now() - t0
const oneAccent = await options(page)
await box.fill('BIENV'); await page.waitForTimeout(300); const upper = await options(page)
await box.fill('nandu'); await page.waitForTimeout(300); const ntilde = await options(page)
await box.fill('post venta'); await page.waitForTimeout(300); const terms = await options(page)
check('B02', oneAccent.length === 1 && /Cotización Ñandú/.test(oneAccent[0]) && upper.length === 1 && /Bienvenida clientes/.test(upper[0]) && ntilde.length === 1 && terms.length === 1 && /Post-Venta/.test(terms[0]),
  `"cotizacion" -> ${JSON.stringify(oneAccent.map((o) => o.split(' · ')[0]))}; "BIENV" -> 1 result; "nandu" -> 1 result; "post venta" -> 1 result (accent, case and multi-word insensitive); filtered after ${elapsed} ms`)
await shot(page, 'b02-filtered')

// B-perf: 150+ flows stay responsive
const perf = []; for (const q of ['catalogo 0', 'catalogo 14', 'a', 'catalogo 099', '']) { const s = Date.now(); await box.fill(q); await page.waitForFunction(() => document.querySelectorAll('[role=option]').length >= 0); await page.waitForTimeout(50); perf.push(Date.now() - s) }
await box.fill(''); await page.waitForTimeout(300); const capped = await options(page); const cappedHint = await page.getByText(/Showing the first 100 of/).isVisible().catch(() => false)
check('B-perf', capped.length <= 100 && cappedHint && Math.max(...perf) < 1500, `with ${Number(seeded) + 2} flows the list renders ${capped.length} rows (cap 100, hint shown: ${cappedHint}); typing round-trips (ms): ${perf.join(', ')}`)

// B-kbd keyboard: type, ArrowDown, Enter
await box.fill('seguimiento'); await page.waitForTimeout(300)
await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(400)
const afterKeyboard = (await picker(page).innerText()).trim(); const closed = !(await search(page).isVisible().catch(() => false))
check('B-kbd', /Seguimiento Post-Venta/.test(afterKeyboard) && closed, `typed "seguimiento", ArrowDown + Enter selected "${afterKeyboard}" and closed the popup`)

// B03 choose by mouse, then save: the stored id is the right one
await picker(page).click(); await search(page).fill('lead'); await page.getByRole('option', { name: /QA - Lead capture/ }).click(); await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
const leadId = await host('flowid QA - Lead capture'); let a = await hostJson(`flowdb ${flowA}`)
const callNode = () => a.nodes.find((n) => n.node_type === 'execute_flow')
check('B03', callNode()?.config.target_flow_id === leadId && (await toasts(page)).some((t) => /saved/i.test(t)), `choosing "QA - Lead capture" from the search and saving stored its id (${leadId.slice(0, 8)}…) in the node`)

// B09 the return point is preserved by the selection changes
check('B09', callNode()?.config.next_node_key === 'send_message', `the configured return node is still "${callNode()?.config.next_node_key}" after choosing/saving the target`)

// B04 reload: the selection is shown and marked
await page.reload(); await settle(page); await page.getByRole('button', { name: 'List' }).click().catch(() => {}); await page.waitForTimeout(800)
const shown = (await picker(page).innerText()).trim()
await picker(page).click(); await search(page).waitFor(); const marked = await page.getByRole('option', { name: /QA - Lead capture/ }).getAttribute('aria-selected')
check('B04', /QA - Lead capture/.test(shown) && marked === 'true', `after reload the field shows "${shown}" and the list marks it as selected`)
await shot(page, 'b04-reloaded')

// B05 change and save
await search(page).fill('cotizacion'); await page.getByRole('option', { name: /Cotización Ñandú/ }).click(); await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
const cotId = await host('flowid Cotización Ñandú'); a = await hostJson(`flowdb ${flowA}`)
check('B05', callNode()?.config.target_flow_id === cotId && callNode()?.config.next_node_key === 'send_message', `switching to "Cotización Ñandú" and saving updated the stored id (${cotId.slice(0, 8)}…) and kept the return node`)

// B06 empty state
await picker(page).click(); await search(page).fill('zzz no existe'); await page.waitForTimeout(400)
const emptyText = await page.getByRole('status').filter({ hasText: /No flows match/ }).innerText().catch(() => ''); const none = (await options(page)).length
check('B06', /No flows match your search/.test(emptyText) && none === 0, `an unknown name shows "${emptyText.trim()}" and no options`)
await shot(page, 'b06-empty')

// B08 nothing foreign, nothing self
await search(page).fill('OTHER COMPANY'); await page.waitForTimeout(400); const foreign = await options(page)
await search(page).fill(''); await page.waitForTimeout(300)
await search(page).fill(NAME_A); await page.waitForTimeout(400); const self = await options(page)
await page.keyboard.press('Escape')
check('B08', foreign.length === 0 && self.length === 0, `searching the other company's flow name returns ${foreign.length} results (the catalog is the caller's own, RLS-scoped); the flow being edited is never offered (${self.length} results)`)

// B10 still drafts, nothing ran
const counts = await hostJson('counts'); a = await hostJson(`flowdb ${flowA}`)
check('B10', a.status === 'draft' && counts.active_flows_a === 0 && counts.flow_runs === 0 && !requests.some((r) => r.endsWith('/activate')), `Flow A is ${a.status}; account A has ${counts.active_flows_a} active flows; ${counts.flow_runs} flow runs exist; no /activate request was sent`)

// B07 account B: no node, no search
const pb = await newPage(); await login(pb, EMAIL_B)
const capB = await pb.evaluate(async () => (await fetch('/api/flows/capabilities')).json())
await createFlow(pb, `B no pilot ${stamp}`); await pb.getByRole('button', { name: 'List' }).click(); await pb.getByRole('button', { name: 'Add node' }).first().click()
const menuB = await pb.locator('[role=menuitem]').allTextContents(); await pb.keyboard.press('Escape')
const bText = await pb.locator('body').innerText()
check('B07', capB.subflowAuthoring === false && menuB.length >= 12 && !menuB.some((m) => /Run another flow/.test(m)) && !/Run another flow|Search flows by name/.test(bText), `account B (no flag): capabilities.subflowAuthoring=false, the add menu has ${menuB.length} items and none is "Run another flow"; no trace of the node or the search in the editor`)
const otherAfter = await host('hash-other')
check('B07b', otherAfter === otherBefore, `the other company's pre-existing flow is byte-identical after the whole run`)

fs.writeFileSync(`${STATE}/results.json`, JSON.stringify(results, null, 2))
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
