// Subflow-authoring pilot: functional QA in a REAL Chromium against the isolated staging (account A opted in, B not).
// Database facts come from the host driver (qa/subflow-pilot/run-pilot.sh) through request/ack files.
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
const newPage = async () => { const ctx = await browser.newContext({ viewport: { width: 1400, height: 1700 } }); return ctx.newPage() }
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const settle = async (p) => { await p.waitForLoadState('load'); await p.waitForTimeout(1200) }
async function login(page, email) { await page.goto(`${URL}/login`); await page.fill('input[type=email]', email); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }) }
const toasts = (page) => page.locator('[data-sonner-toast]').allTextContents()
const clearToasts = async (page) => { await page.waitForTimeout(300); for (const t of await page.locator('[data-sonner-toast]').all()) await t.click({ timeout: 500 }).catch(() => {}) }
const edited = (page) => page.getByText(/^edited$/i).first().isVisible().catch(() => false)
async function createFlow(page, name) {
  await page.goto(`${URL}/flows`); await settle(page)
  await page.getByRole('button', { name: 'New flow' }).first().click()
  await page.getByRole('dialog').locator('input').first().fill(name); await page.getByRole('button', { name: 'Create blank flow' }).click()
  await page.waitForURL(/\/flows\/[0-9a-f-]{36}/, { timeout: 30000 }); return page.url().match(/\/flows\/([0-9a-f-]{36})/)[1]
}
const menuItems = async (page) => { await page.locator('[role=menuitem]').first().waitFor({ state: 'visible', timeout: 8000 }); const items = await page.locator('[role=menuitem]').allTextContents(); await page.keyboard.press('Escape'); await page.waitForTimeout(300); return items }
async function add(page, label) { await page.getByRole('button', { name: 'Add node' }).first().click(); await page.getByRole('menuitem', { name: new RegExp('^' + label) }).click(); await page.waitForTimeout(250) }
// the "Flow to run" field is a searchable picker: open it, type part of the name, click the match
async function pickFlow(page, combobox, name) { await combobox.click(); await page.getByPlaceholder('Search flows by name…').fill(name); await page.getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click(); await page.waitForTimeout(250) }
async function pickIn(page, combobox, option) { await combobox.click(); await page.getByRole('option', { name: option, exact: true }).click(); await page.waitForTimeout(200) }
const stamp = Date.now().toString(36)
const NAME_A = `Pilot A ${stamp}`, NAME_B = `Pilot B ${stamp}`, NAME_C = `Pilot C ${stamp}`

// ------------------------------------------------------------------------------------------- account A (opted in)
const page = await newPage()
const requests = []; page.on('request', (r) => { if (r.url().includes('/api/flows')) requests.push(`${r.method()} ${r.url().replace(URL, '')}`) })
await login(page, EMAIL_A)
const ids = await hostJson('ids'); const otherBefore = await host('hash-other')
const capA = await page.evaluate(async () => (await fetch('/api/flows/capabilities')).json())

// P-01 create B (target) and A
const flowB = await createFlow(page, NAME_B); const flowA = await createFlow(page, NAME_A)
let a = await hostJson(`flowdb ${flowA}`), b = await hostJson(`flowdb ${flowB}`)
check('P-01', capA.subflowAuthoring === true && a.status === 'draft' && b.status === 'draft' && a.account_id === ids.account_a && b.account_id === ids.account_a,
  `account A (opted in: capabilities.subflowAuthoring=${capA.subflowAuthoring}) created Flow A and Flow B as drafts in its own account`)

// P-02 list view: add "Run another flow", pick B, set the return node, connect, save
await page.getByRole('button', { name: 'List' }).click()
await page.getByRole('button', { name: 'Add node' }).first().click(); const listMenu = await menuItems(page)
await add(page, 'Start'); await add(page, 'Run another flow'); await add(page, 'Send message'); await add(page, 'End')
const cbs = () => page.getByRole('combobox')
await page.getByPlaceholder('support, help, hi').fill('hola, piloto')
await pickIn(page, cbs().nth(2), 'run_another_flow')                                     // start -> call
await pickFlow(page, page.getByRole('combobox', { name: 'Flow to run' }), NAME_B)   // target = B
await pickIn(page, cbs().nth(4), 'send_message')                                         // when B ends, continue at send_message
await page.locator('textarea').last().fill('Volvimos del flujo B'); await pickIn(page, cbs().nth(5), 'end')
const draftNotice = await page.getByText(/Running them is not enabled yet/).first().isVisible()
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
const tSave = await toasts(page); a = await hostJson(`flowdb ${flowA}`)
const callNode = () => a.nodes.find((n) => n.node_type === 'execute_flow')
const p02 = { menu: listMenu.some((m) => /^Run another flow/.test(m)), saved: tSave.some((t) => /saved/i.test(t)), target: callNode()?.config.target_flow_id === flowB, ret: callNode()?.config.next_node_key === 'send_message', start: a.nodes.find((n) => n.node_key === 'start')?.config.next_node_key, notice: draftNotice, edited: await edited(page), toasts: tSave }
check('P-02', p02.menu && p02.saved && p02.target && p02.ret && p02.start === 'run_another_flow' && p02.notice && !p02.edited,
  `${JSON.stringify(p02)} list view: "Run another flow" offered, Flow B picked from the account's flows, return node = send_message, start -> run_another_flow -> (B) -> send_message -> end saved ("Saved."), draft-only notice shown`)
await shot(page, 'p-02-list-connected')

// P-03 reload: everything comes back
await page.reload(); await settle(page); await page.getByRole('button', { name: 'List' }).click().catch(() => {}); await page.waitForTimeout(800)
const shownTarget = await page.getByRole('combobox', { name: 'Flow to run' }).innerText()
check('P-03', shownTarget.includes(NAME_B) && (await cbs().nth(4).innerText()).includes('send_message'), `after a reload the node shows "${shownTarget.trim()}" and continues at send_message`)

// P-04 canvas view: the node is there, the add menu offers it, a second one can be added and configured in the side sheet
await page.getByRole('button', { name: 'Canvas' }).click(); await page.waitForTimeout(1200)
const canvasCard = await page.locator('.react-flow__node').filter({ hasText: /run another flow/i }).count()
await page.getByRole('button', { name: 'Add node' }).last().click(); const canvasMenu = await menuItems(page)
await page.getByRole('button', { name: 'Add node' }).last().click(); await page.getByRole('menuitem', { name: /^Run another flow/ }).click(); await page.waitForTimeout(600)
await page.locator('.react-flow__node').filter({ hasText: /run_another_flow_2/ }).first().click(); await page.waitForTimeout(600)
await pickFlow(page, page.getByRole('combobox', { name: 'Flow to run' }).last(), NAME_B)
await page.keyboard.press('Escape'); await page.waitForTimeout(300)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
a = await hostJson(`flowdb ${flowA}`); const calls = a.nodes.filter((n) => n.node_type === 'execute_flow')
const p04 = { card: canvasCard, menu: canvasMenu, calls: calls.map((n) => [n.node_key, n.config.target_flow_id === flowB]) }
check('P-04', canvasCard >= 1 && canvasMenu.some((m) => /^Run another flow/.test(m)) && calls.length === 2 && calls.every((n) => n.config.target_flow_id === flowB),
  `${JSON.stringify(p04)} canvas view: the node card is rendered, the canvas add menu offers "Run another flow", a second node added and configured in the side panel was saved (2 execute_flow nodes -> Flow B)`)
await shot(page, 'p-04-canvas')

// P-05 change the reference to another flow (C) and save
const flowC = await createFlow(page, NAME_C); await page.goto(`${URL}/flows/${flowA}`); await settle(page); await page.getByRole('button', { name: 'List' }).click()
await pickFlow(page, page.getByRole('combobox', { name: 'Flow to run' }).first(), NAME_C)
await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500)
a = await hostJson(`flowdb ${flowA}`)
check('P-05', a.nodes.find((n) => n.node_key === 'run_another_flow').config.target_flow_id === flowC, `the first node now points at Flow C; saved`)

// P-06 sign out and back in
await page.locator('button').filter({ hasText: 'QA Owner A' }).first().click(); await page.getByRole('menuitem', { name: 'Sign out' }).click(); await page.waitForURL(/\/login/)
await login(page, EMAIL_A); await page.goto(`${URL}/flows/${flowA}`); await settle(page); await page.getByRole('button', { name: 'List' }).click(); await page.waitForTimeout(800)
const t1 = await page.getByRole('combobox', { name: 'Flow to run' }).first().innerText(), t2 = await page.getByRole('combobox', { name: 'Flow to run' }).last().innerText()
check('P-06', t1.includes(NAME_C) && t2.includes(NAME_B), `after signing out and in again: node 1 -> "${t1.trim()}", node 2 -> "${t2.trim()}"`)
await shot(page, 'p-06-after-relogin')

// P-07 activation is refused (UI and server), everything stays draft, nothing ran
// the UI does not even offer activation (the validator reports the node), the server refuses it independently
const activateDisabled = await page.getByRole('button', { name: 'Activate' }).isDisabled()
const uiIssue = await page.getByText(/require versioned execution/i).first().isVisible().catch(() => false)
const api = await page.evaluate(async ({ flowA }) => { const r = await fetch(`/api/flows/${flowA}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }) }); return { status: r.status, body: await r.json().catch(() => ({})) } }, { flowA })
a = await hostJson(`flowdb ${flowA}`); b = await hostJson(`flowdb ${flowB}`); const c = await hostJson(`flowdb ${flowC}`); const counts = await hostJson('counts')
check('P-07', api.status === 409 && api.body.code === 'subflow_execution_disabled' && [a, b, c].every((f) => f.status === 'draft') && counts.flow_runs === 0 && counts.active_flows_a === 0 && activateDisabled && uiIssue,
  `Activate is disabled in the UI (the issue panel reports the node: ${uiIssue}); the API refuses it too (409 ${api.body.code}); Flow A, B and C are drafts; account A has 0 active flows and 0 runs`)

// P-08 invalid references are refused with a clear message and nothing is saved
const before = await host(`hash ${flowA}`)
const bad = await page.evaluate(async ({ flowA, foreign }) => {
  const body = (target) => JSON.stringify({ nodes: [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'x' } }, { node_key: 'x', node_type: 'execute_flow', config: { target_flow_id: target, next_node_key: '' } }] })
  const r1 = await fetch(`/api/flows/${flowA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body(foreign) })
  const r2 = await fetch(`/api/flows/${flowA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body(flowA) })
  const r3 = await fetch(`/api/flows/${flowA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body('00000000-0000-4000-8000-000000000000') })
  return [r1.status, r2.status, r3.status, (await r1.json()).error]
}, { flowA, foreign: ids.flow_b })
const afterBad = await host(`hash ${flowA}`)
// delete Flow C: Flow A now shows the dangling reference and refuses to save it
await page.evaluate(async ({ flowC }) => fetch(`/api/flows/${flowC}`, { method: 'DELETE' }), { flowC })
await page.reload(); await settle(page); await page.getByRole('button', { name: 'List' }).click(); await page.waitForTimeout(1200)
const alert = await page.getByRole('alert').first().textContent().catch(() => '')
await clearToasts(page); await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(1500); const tDangling = await toasts(page)
check('P-08', bad[0] === 422 && bad[1] === 422 && bad[2] === 422 && afterBad === before && /no longer exists/i.test(alert) && tDangling.some((t) => /does not exist anymore|Nothing was saved/i.test(t)) && (await host(`hash ${flowA}`)) === before,
  `PUT with another company's flow / the flow itself / an unknown id -> 422 ("${bad[3]}"), Flow A unchanged; after Flow C was deleted the editor warns "${(alert ?? '').slice(0, 60)}…" and saving is refused with "${(tDangling[0] ?? '').slice(0, 60)}…", nothing written`)
await shot(page, 'p-08-dangling')

// ------------------------------------------------------------------------------------------- account B (not opted in)
const pb = await newPage(); await login(pb, EMAIL_B)
const capB = await pb.evaluate(async () => (await fetch('/api/flows/capabilities')).json())
const flowBB = await createFlow(pb, `Company B flow ${stamp}`)
await pb.getByRole('button', { name: 'List' }).click(); await pb.getByRole('button', { name: 'Add node' }).first().click(); const listMenuB = await menuItems(pb)
await pb.getByRole('button', { name: 'Canvas' }).click(); await pb.waitForTimeout(1500); await pb.getByRole('button', { name: 'Add node' }).last().click(); const canvasMenuB = await menuItems(pb)
const bPageText = await pb.locator('body').innerText()
const forged = await pb.evaluate(async ({ id, own }) => {
  const r = await fetch(`/api/flows/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subflowAuthoring: true, nodes: [{ node_key: 's', node_type: 'start', config: { next_node_key: 'x' } }, { node_key: 'x', node_type: 'execute_flow', config: { target_flow_id: own } }] }) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, { id: flowBB, own: ids.flow_b })
const bbNodes = (await hostJson(`flowdb ${flowBB}`)).nodes
check('P-09', capB.subflowAuthoring === false && !/run another flow/i.test(bPageText) && listMenuB.length >= 12 && canvasMenuB.length >= 12 && !listMenuB.some((m) => /Run another flow/.test(m)) && !canvasMenuB.some((m) => /Run another flow/.test(m)) && listMenuB.some((m) => /^Send message/.test(m)) && forged.status === 403 && forged.body.code === 'subflow_authoring_disabled' && bbNodes.length === 0,
  `account B (not opted in): capabilities.subflowAuthoring=false, the editor shows no trace of it (legend, menus), neither add menu offers the node (list ${listMenuB.length} items, canvas ${canvasMenuB.length}), a forged PUT carrying an execute_flow node is refused 403 ${forged.body.code} and nothing is stored`)
await shot(pb, 'p-09-company-b-menu')
// B's normal flows keep working: a plain valid flow still activates (positive control: the guards only concern execute_flow)
await pb.getByRole('button', { name: 'List' }).click()
const addB = async (label) => { await pb.getByRole('button', { name: 'Add node' }).first().click(); await pb.getByRole('menuitem', { name: new RegExp('^' + label) }).click(); await pb.waitForTimeout(250) }
await addB('Start'); await addB('Send message'); await addB('End')
await pb.getByPlaceholder('support, help, hi').fill('b-control')
await pickIn(pb, pb.getByRole('combobox').nth(2), 'send_message'); await pb.locator('textarea').last().fill('control B'); await pickIn(pb, pb.getByRole('combobox').nth(3), 'end')
await pb.getByRole('button', { name: 'Activate' }).click(); await pb.waitForTimeout(2500)
const bb = await hostJson(`flowdb ${flowBB}`); const otherAfter = await host('hash-other')
check('P-10', bb.status === 'active' && otherAfter === otherBefore && (await hostJson('counts')).flow_runs === 0,
  `account B still saves and ACTIVATES an ordinary flow (status ${bb.status}); B's pre-existing flow is byte-identical; no flow run was created anywhere`)
// leave the control flow as it was found: back to draft
await pb.evaluate(async ({ id }) => fetch(`/api/flows/${id}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'draft' }) }), { id: flowBB })

fs.writeFileSync(`${STATE}/results.json`, JSON.stringify(results, null, 2))
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
