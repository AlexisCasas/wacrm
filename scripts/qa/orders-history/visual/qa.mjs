// Visual + behaviour QA of the "Pedidos confirmados" panel in headless Chromium, against the built harness (synthetic data, fetch mocked).
// Usage: node qa.mjs   (expects the harness served on http://127.0.0.1:4173; screenshots go to $OUT or /out)
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = process.env.OUT ?? '/out'
fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' ' + extra}`) }

const browser = await chromium.launch()
const open = async (s, theme = 'violet', size = { width: 320, height: 900 }) => {
  const ctx = await browser.newContext({ viewport: size, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const requests = []
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`))
  await page.goto(`http://127.0.0.1:4173/?s=${s}&theme=${theme}`)
  await page.waitForTimeout(600)
  return { ctx, page, errors, requests }
}
const noOverflow = (page) => page.evaluate(() => { const c = document.getElementById('col'); return c.scrollWidth <= c.clientWidth && document.documentElement.scrollWidth <= innerWidth })
const text = (page) => page.evaluate(() => document.getElementById('col').innerText)

for (const theme of ['violet', 'amber']) {
  // empty
  let t = await open('empty', theme)
  check(`[${theme}] empty: title with 0 and empty-state text`, (await text(t.page)).toLowerCase().includes('pedidos confirmados (0)') && (await text(t.page)).includes('Aún no hay pedidos confirmados'))
  check(`[${theme}] empty: the "Confirmar pedido" button is still there`, await t.page.getByRole('button', { name: 'Confirmar pedido' }).isVisible())
  await t.page.screenshot({ path: `${OUT}/empty-${theme}.png` }); await t.ctx.close()

  // one (acknowledged)
  t = await open('one', theme)
  let body = await text(t.page)
  check(`[${theme}] one: count 1, product, amount, "Recibido en InkaClick"`, body.includes('(1)') && body.includes('Producto sintético 1') && body.includes('S/ 110.00') && body.includes('Recibido en InkaClick'))
  check(`[${theme}] one: Lima time (10+1=11:24 UTC -> 06:24 Lima)`, body.includes('06:24') && body.includes('(Lima)'))
  await t.page.getByText('Producto sintético 1').click()
  const dlg = t.page.getByRole('dialog')
  await dlg.waitFor()
  const d = await dlg.innerText()
  check(`[${theme}] one: detail has author and seller as separate rows`, d.includes('Confirmó') && d.includes('Keyler Ortega') && d.includes('Vendedor') && d.includes('David Riveros'))
  check(`[${theme}] one: detail has sent (19:57 Lima) and InkaClick-confirmed (20:01 Lima) dates and the id`, d.includes('19:57') && d.includes('20:01') && d.includes('00000001-5719-4ace-8adb-7e317141947c'))
  await t.page.screenshot({ path: `${OUT}/one-detail-${theme}.png` })
  await t.page.keyboard.press('Escape')
  await t.page.waitForTimeout(300)
  check(`[${theme}] one: detail closes`, (await t.page.getByRole('dialog').count()) === 0)
  check(`[${theme}] one: only GET requests, no writes`, t.requests.every((r) => r.startsWith('GET ')), t.requests.join(','))
  await t.page.screenshot({ path: `${OUT}/one-${theme}.png` }); await t.ctx.close()

  // all seven states + long name
  t = await open('states', theme)
  body = await text(t.page)
  for (const label of ['Confirmado en WACRM · envío a InkaClick no activado', 'pendiente de envío', 'enviando…', 'Enviado a InkaClick · verificando recepción', 'Recibido en InkaClick', 'InkaClick lo rechazó · requiere revisión', 'Reintentos agotados · requiere revisión']) {
    check(`[${theme}] states: "${label}"`, body.includes(label))
  }
  check(`[${theme}] states: exactly one "Recibido en InkaClick" (only acknowledged)`, body.split('Recibido en InkaClick').length - 1 === 1)
  check(`[${theme}] states: the held card never says "pendiente"`, !/pendiente/i.test(await t.page.locator('#col ul > li').first().innerText()))
  check(`[${theme}] states: 280px column without horizontal overflow (long product name truncates)`, await noOverflow(t.page))
  check(`[${theme}] states: no page errors`, t.errors.length === 0, t.errors.join(' | '))
  await t.page.screenshot({ path: `${OUT}/states-${theme}.png`, fullPage: true }); await t.ctx.close()

  // six
  t = await open('six', theme)
  check(`[${theme}] six: six cards`, (await t.page.locator('#col ul > li').count()) === 6)
  await t.page.screenshot({ path: `${OUT}/six-${theme}.png`, fullPage: true }); await t.ctx.close()

  // error / off / many
  t = await open('error', theme)
  check(`[${theme}] error on first load: panel hidden, button unaffected`, !(await text(t.page)).includes('Pedidos confirmados') && (await t.page.getByRole('button', { name: 'Confirmar pedido' }).isVisible()))
  await t.ctx.close()
  t = await open('off', theme)
  check(`[${theme}] feature off: no panel`, !(await text(t.page)).includes('Pedidos confirmados'))
  await t.ctx.close()
  t = await open('many', theme)
  body = await text(t.page)
  check(`[${theme}] many: "(50+)" and the 50-orders note`, body.includes('(50+)') && body.includes('50 pedidos más recientes'))
  await t.ctx.close()
}

// the confirm dialog still opens from the button, with the panel mounted
{
  const t = await open('one', 'violet')
  await t.page.getByRole('button', { name: 'Confirmar pedido' }).click()
  await t.page.getByRole('dialog').waitFor()
  check('confirm button still opens its dialog', (await t.page.getByRole('dialog').innerText()).length > 20)
  await t.page.screenshot({ path: `${OUT}/confirm-dialog.png` }); await t.ctx.close()
}
// keyboard: cards are buttons, reachable with Tab and opened with Enter
{
  const t = await open('one', 'violet')
  await t.page.locator('#col ul button').first().focus()
  await t.page.keyboard.press('Enter')
  check('card opens with the keyboard', (await t.page.getByRole('dialog').count()) === 1)
  await t.ctx.close()
}
await browser.close()
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
