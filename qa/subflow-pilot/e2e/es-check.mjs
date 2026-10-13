import { chromium } from '/qa/staging/pw/node_modules/playwright-core/index.mjs'
const { URL, EMAIL, PASSWORD } = process.env
const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1400, height: 1700 } })).newPage()
await page.goto(`${URL}/login`); await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]')
await page.waitForURL((u) => !u.pathname.startsWith('/login')); await page.goto(`${URL}/flows`); await page.waitForTimeout(1500)
await page.goto(`${URL}/flows/${process.env.FLOW}`); await page.waitForTimeout(2000)
await page.getByRole('button', { name: /Lista|List/ }).click().catch(() => {}); await page.waitForTimeout(800)
const add = page.getByRole('button', { name: /Agregar nodo|Añadir nodo|Add node/ }).first(); await add.click(); await page.waitForTimeout(400)
console.log('menu:', (await page.locator('[role=menuitem]').allTextContents()).filter((t) => /flujo/i.test(t)))
await page.keyboard.press('Escape')
console.log('texts:', ['Ejecutar otro flujo', 'Flujo a ejecutar', 'Cuando ese flujo termine, continuar en'].map((t) => `${t}=${page.getByText(t).first() ? 'ok' : 'no'}`).join(' '))
for (const t of ['EJECUTAR OTRO FLUJO', 'Flujo a ejecutar', 'Cuando ese flujo termine, continuar en', 'borrador']) console.log(t, await page.getByText(t, { exact: false }).first().isVisible().catch(() => false))
await page.screenshot({ path: '/qa-pilot/shots/p-es-editor.png', fullPage: true }); await browser.close()
