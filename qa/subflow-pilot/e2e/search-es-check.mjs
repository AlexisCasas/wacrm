import { chromium } from '/qa/staging/pw/node_modules/playwright-core/index.mjs'
const { URL, EMAIL, PASSWORD, FLOW } = process.env
const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1400, height: 1700 } })).newPage()
await page.goto(`${URL}/login`); await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]')
await page.waitForURL((u) => !u.pathname.startsWith('/login')); await page.goto(`${URL}/flows/${FLOW}`); await page.waitForTimeout(2000)
await page.getByRole('button', { name: /Lista|List/ }).click().catch(() => {}); await page.waitForTimeout(800)
await page.getByRole('combobox', { name: 'Flujo a ejecutar' }).click(); await page.waitForTimeout(500)
const box = page.getByPlaceholder('Buscar flujos por nombre…'); console.log('search box (es):', await box.isVisible())
await box.fill('cotizacion'); await page.waitForTimeout(400); console.log('results:', await page.getByRole('option').allTextContents())
await box.fill('zzzz'); await page.waitForTimeout(400); console.log('empty (es):', await page.getByRole('status').innerText())
await page.screenshot({ path: '/qa-pilot/shots/b-es-empty.png' }); await box.fill(''); await page.waitForTimeout(400)
console.log('capped hint (es):', await page.getByText(/Mostrando las primeras/).innerText().catch(() => 'none'))
await browser.close()
