import { chromium } from 'playwright'
const BASE = 'http://localhost:4173/'
const mk = (o) => ({ id: crypto.randomUUID(), manychat_contact_id: null, nombre: null, apellido: null, nombre_completo: 'Cliente Sintetico', dni: '12345678', dni_normalized: '12345678', telefono: '51900000001', telefono_normalized: '51900000001', producto: 'Producto X', cantidad_productos: 1, precio: 10, pago_inicial: 0, pago_restante: 10, destino: 'Lima, Lima', agencia: 'Shalom', vendedor: 'Vendedor Uno', estado_pedido: 'Pedido confirmado', fecha_text: '2026-10-31', fecha_hora_text: '2026-10-31T19:41:46-05:00', descripcion_pedido_url: null, departamento: null, source: 'manychat', duplicate_key: 'k', raw_payload: {}, created_at: '2026-10-31T20:00:00Z', updated_at: '2026-10-31T20:00:00Z', annulment_status: 'active', ...o })
const XSS = '<img src=x onerror="window.__xss=1"> javascript:window.__xss=2\nSegunda línea del texto libre'
const orders = [
  mk({ id: 'e2e00000-0000-4000-8000-000000000001', producto: 'PRUEBA WACRM E2E - NO DESPACHAR', precio: 1, pago_restante: 1, destino: 'San Martín, Tarapoto', departamento: 'Junín', vendedor: 'Vendedor WACRM', source: 'wacrm', descripcion_pedido_url: XSS, nombre_completo: 'Cliente WACRM' }),
  mk({ id: 'mc000000-0000-4000-8000-000000000002', producto: 'Pedido ManyChat con enlace', descripcion_pedido_url: 'https://example.com/pedido/123?x=1', nombre_completo: 'Cliente ManyChat Uno' }),
  mk({ id: 'mc000000-0000-4000-8000-000000000003', producto: 'Pedido ManyChat sin descripcion', nombre_completo: 'Cliente ManyChat Dos' }),
  mk({ id: 'mc000000-0000-4000-8000-000000000004', producto: 'Pedido con javascript', descripcion_pedido_url: 'javascript:window.__xss=3', nombre_completo: 'Cliente Js' }),
]
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const log = []; const writes = []
await ctx.addInitScript(() => {
  const s = { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 99999, expires_at: Math.floor(Date.now() / 1000) + 99999, user: { id: 'u1', aud: 'authenticated', email: 'qa@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } }
  localStorage.setItem('sb-sb-auth-token', JSON.stringify(s)); localStorage.setItem('voucheradmin_user', 'qa@example.test')
})
await ctx.route(/\/\/(sb|api)\.test\//, async (route) => {
  const req = route.request(); const url = new URL(req.url()); const m = req.method()
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  if (m !== 'GET') writes.push(`${m} ${url.pathname}`)
  const json = (b) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(b) })
  if (url.host === 'sb.test') {
    if (url.pathname.includes('/user_profiles')) return json((req.headers()['accept'] || '').includes('pgrst.object') ? { id: 'u1', email: 'qa@example.test', nombre: 'QA', rol: 'super_admin', estado: 'activo' } : [])
    return json((req.headers()['accept'] || '').includes('pgrst.object') ? {} : [])
  }
  if (url.pathname.startsWith('/api/confirmed-orders') && m === 'GET' && !url.pathname.endsWith('/send-confirmed-order-whatsapp')) {
    return json({ data: orders, pagination: { page: 1, pageSize: 25, total: orders.length, totalPages: 1, from: 1, to: orders.length }, summary: { totalPedidos: orders.length, confirmados: orders.length, procesados: 0, pagados: 0, anulados: 0 } })
  }
  return json({})
})
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') log.push('console.error: ' + m.text().slice(0, 140)) })
page.on('dialog', (d) => { log.push('DIALOG: ' + d.message().slice(0, 80)); d.dismiss() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: '/out/00-inicio.png' })
const nav = page.getByText('Pedidos confirmados', { exact: false }).first()
console.log('nav visible:', await nav.isVisible().catch(() => false))
await nav.click()
await page.waitForTimeout(1500)
await page.screenshot({ path: '/out/01-listado.png' })

const res = []; const rec = (n, ok, note = '') => { res.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (note ? ' — ' + note : '')) }
const vis = (t) => page.getByText(t, { exact: true }).locator('visible=true')
const UNIQ = ['Nombre', 'Teléfono', 'Producto', 'Destino', 'Estado del pedido', 'Fecha']
const cols = async () => { const out = []; for (const l of UNIQ.concat(['Departamento'])) if ((await vis(l).count()) > 0) out.push(l); return out }
const openMenu = async () => { if (!(await page.getByText('Columnas visibles').isVisible().catch(() => false))) { await page.getByRole('button', { name: /^Columnas$/i }).click(); await page.waitForTimeout(400) } }
const closeMenu = async () => { if (await page.getByText('Columnas visibles').isVisible().catch(() => false)) { await page.mouse.click(1418, 413); await page.waitForTimeout(400) } }
const toggle = async (label) => { await openMenu(); await page.getByLabel(label, { exact: true }).click(); await page.waitForTimeout(400); await closeMenu() }
const base = await cols(); console.log('columnas base:', JSON.stringify(base))
// 4. Columna Departamento: habilitar / deshabilitar sin afectar las demás
await openMenu()
await page.screenshot({ path: '/out/02-menu-columnas.png' })
const dep = page.getByLabel('Departamento', { exact: true })
rec('4a. La columna Departamento aparece en el menú de columnas', await dep.isVisible().catch(() => false))
await dep.click(); await page.waitForTimeout(500); await closeMenu()
const withDep = await cols(); console.log('columnas con Departamento:', JSON.stringify(withDep))
rec('4b. Habilitada: aparece "Departamento" y las otras columnas siguen', withDep.includes('Departamento') && UNIQ.every((c) => withDep.includes(c)))
const depCell = await page.getByText('Junín', { exact: true }).count()
rec('4c. La celda del pedido E2E muestra el departamento (Junín)', depCell >= 1)
await page.screenshot({ path: '/out/03-listado-con-departamento.png' })
await toggle('Departamento')
const off = await cols()
rec('4d. Deshabilitada: desaparece y quedan exactamente las columnas base', !off.includes('Departamento') && JSON.stringify(off) === JSON.stringify(base))

// vendedor: columna opcional del listado
await toggle('Vendedor')
rec('1f. Con la columna Vendedor habilitada, el listado muestra el vendedor del pedido E2E', (await page.getByText('Vendedor WACRM', { exact: true }).count()) >= 1)
await page.screenshot({ path: '/out/03b-listado-con-vendedor.png' })
await toggle('Vendedor')
// detalle de cada pedido
const closeDetail = async () => { const b = page.getByRole('button', { name: /Cerrar Detalle/i }).first(); if (await b.isVisible().catch(() => false)) await b.click(); await page.waitForTimeout(400) }
const openDetail = async (name) => { await page.getByText(name, { exact: true }).first().locator('xpath=ancestor::div[.//button[@title="Ver detalle"]][1]').locator('button[title="Ver detalle"]').first().click(); await page.waitForTimeout(700) }
const snap = async (file) => { await page.screenshot({ path: '/out/' + file }); }
const anchors = async () => page.locator('a[href]').evaluateAll((as) => as.filter((a) => /Descripci|enlace|example\.com|javascript/i.test(a.textContent + a.getAttribute('href'))).map((a) => ({ t: (a.textContent || '').trim().slice(0, 40), h: a.getAttribute('href') })))
// 1 y 2. Pedido E2E WACRM
await openDetail('Cliente WACRM'); await snap('04-detalle-e2e.png')
const txt = await page.locator('body').innerText()
rec('1a. Detalle E2E: producto', txt.includes('PRUEBA WACRM E2E - NO DESPACHAR'))
rec('1b. Detalle E2E: precio S/ 1.00', /S\/\s*1[.,]00/.test(txt), (txt.match(/S\/\s*[0-9.,]+/g) || []).slice(0, 3).join(' '))
rec('1c. Detalle E2E: destino', txt.includes('San Martín, Tarapoto'))
rec('1d. Detalle E2E: el vendedor NO se muestra en el detalle (comportamiento previo, no cambia con el PR)', !txt.includes('Vendedor WACRM'))
rec('1e. Detalle E2E: departamento Junín y etiqueta Departamento', /Departamento/i.test(txt) && txt.includes('Junín'))
rec('2a. Descripción libre visible como texto', txt.includes('Segunda línea del texto libre'))
const a1 = await anchors(); console.log('enlaces de descripción (E2E):', JSON.stringify(a1))
rec('2b. La descripción de texto libre NO es un enlace', a1.length === 0)
rec('2c. Sin XSS: ni onerror ni javascript: se ejecutaron', (await page.evaluate(() => window.__xss)) === undefined)
rec('2d. La etiqueta dice "Descripción del Pedido"', /Descripción del Pedido/i.test(txt) && !/Descripción URL del Pedido/i.test(txt))
// 5. edición sin guardar
const editBtn = page.getByRole('button', { name: /Editar/i }).first()
if (await editBtn.isVisible().catch(() => false)) {
  await editBtn.click(); await page.waitForTimeout(600); await snap('05-edicion-e2e.png')
  const inp = await page.locator('input[name="descripcion_pedido_url"], textarea[name="descripcion_pedido_url"]').count()
  rec('5a. El modo edición abre y muestra el campo de descripción', inp >= 1)
  const cancel = page.getByRole('button', { name: /Cancelar/i }).first()
  rec('5b. Se puede cancelar la edición sin guardar', await cancel.isVisible().catch(() => false)); if (await cancel.isVisible().catch(() => false)) await cancel.click()
  await page.waitForTimeout(400)
} else rec('5a. Botón Editar encontrado', false)
await closeDetail()
// 3. ManyChat con enlace http(s)
await openDetail('Cliente ManyChat Uno'); await snap('06-detalle-manychat-enlace.png')
const a2 = await anchors(); console.log('enlaces (ManyChat):', JSON.stringify(a2))
rec('3a. El enlace HTTP(S) histórico de ManyChat sigue siendo un enlace', a2.some((x) => x.h === 'https://example.com/pedido/123?x=1'))
const a2attr = await page.locator('a[href="https://example.com/pedido/123?x=1"]').first().evaluate((a) => ({ t: a.target, r: a.rel })).catch(() => null)
rec('3b. Abre en pestaña nueva con rel noopener noreferrer', !!a2attr && a2attr.t === '_blank' && /noopener/.test(a2attr.r) && /noreferrer/.test(a2attr.r), JSON.stringify(a2attr))
await closeDetail()
await openDetail('Cliente ManyChat Dos'); const t3 = await page.locator('body').innerText(); rec('3c. Pedido ManyChat sin descripción: muestra N/A y sin enlace', (await anchors()).length === 0 && /N\/A/.test(t3))
await closeDetail()
await openDetail('Cliente Js'); const a4 = await anchors(); rec('3d. Valor javascript: histórico: ni enlace ni ejecución', a4.length === 0 && (await page.evaluate(() => window.__xss)) === undefined, JSON.stringify(a4))
await snap('07-detalle-javascript.png')
// 5 navegación + escrituras
await closeDetail()
await page.getByText('Clientes', { exact: true }).first().click(); await page.waitForTimeout(800); await page.getByText('Pedidos confirmados', { exact: false }).first().click(); await page.waitForTimeout(800)
rec('5c. Navegación listado → clientes → listado sin errores', (await page.getByText('PRUEBA WACRM E2E').count()) >= 1)
const badWrites = writes.filter((w) => !/user_profiles/.test(w))
rec('5d. Ninguna escritura al backend simulado durante el QA (salvo el perfil de sesión simulado)', badWrites.length === 0, JSON.stringify(badWrites))
console.log('errores de consola:', JSON.stringify(log.filter((l) => !/user_profiles|Failed to load resource|401|404/.test(l)).slice(0, 5)))
console.log(JSON.stringify({ total: res.length, fallos: res.filter((r) => !r.ok).map((r) => r.n) }))
await browser.close()
