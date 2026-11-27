// Selectors of the screens under test, in Spanish (the app is built with NEXT_PUBLIC_APP_LOCALE=es).
import { APP, until } from './harness.mjs'

const LOGISTICS_HINT = 'Gestión del pedido de esta conversación'
const PAYMENT_HINT = 'Registra únicamente el monto recibido.'

export const logisticsAside = (page) => page.locator('aside').filter({ hasText: LOGISTICS_HINT })

export async function openChat(page, conversationId) {
  await page.goto(`${APP}/inbox?c=${conversationId}`, { waitUntil: 'domcontentloaded' })
}

export async function openPanel(page, conversationId, { supervisor = false } = {}) {
  await openChat(page, conversationId)
  if (supervisor) await page.getByRole('tab', { name: 'Logística' }).click({ timeout: 45_000 })
  const aside = logisticsAside(page)
  await aside.waitFor({ timeout: 45_000 })
  return aside
}

export const field = (aside, label) => aside.locator(`label:text-is("${label}") + input`)
export const quantity = (aside, index = 0) => field(aside, 'Cantidad').nth(index)
export const price = (aside, index = 0) => field(aside, 'Precio').nth(index)
export const productName = (aside, index = 0) => aside.getByPlaceholder('Nombre del producto').nth(index)
export const accessoryName = (aside, index = 0) => aside.getByPlaceholder('Nombre del accesorio').nth(index)
export const description = (aside) => aside.getByPlaceholder('Descripción del pedido')
export const payInput = (aside) => aside.getByPlaceholder('0.00')
export const save = (aside) => aside.getByRole('button', { name: 'Guardar', exact: true }).first().click()
export const totalShown = async (aside) => (await aside.locator('section').filter({ hasText: PAYMENT_HINT }).locator('span:text-is("Total") + span').first().innerText()).trim()
export const totalNotice = (aside) => aside.getByRole('status').filter({ hasText: 'el total del pedido cambiará' })

/** The editor of one order, loaded: the buyer field shows that order's name. */
export async function editorReady(aside, order) {
  await aside.getByText(PAYMENT_HINT).waitFor({ timeout: 45_000 })
  await until(async () => (await field(aside, 'Nombre completo').inputValue()) === order.customer_name, 'the order editor')
}

export async function panelFor(t, userKey, order, options) {
  const page = await t.page(userKey)
  const aside = await openPanel(page, order.conversationId, options)
  await editorReady(aside, order)
  return { page, aside }
}

export const toast = (page, text) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first().waitFor({ timeout: 25_000 })

/** The order drawer of "Pedidos confirmados", through its deep link. */
export async function openDetail(t, userKey, orderId) {
  const page = await t.page(userKey)
  await page.goto(`${APP}/confirmed-orders?order=${orderId}`, { waitUntil: 'domcontentloaded' })
  const section = page.locator('section[aria-label="Gestión del pedido"]')
  await section.waitFor({ timeout: 60_000 })
  return { page, section }
}

export async function openEditForm(page, section) {
  await section.getByRole('button', { name: 'Editar pedido', exact: true }).click()
  const form = page.getByRole('form', { name: 'Editar pedido' })
  await form.waitFor()
  return form
}

export async function submitForm(form, reason = 'corrección QA') {
  await form.getByLabel('Motivo (obligatorio)').fill(reason)
  await form.getByRole('button', { name: 'Guardar cambios' }).click()
}

export const deriveButton = (scope) => scope.getByRole('button', { name: 'Derivar a Comercial' })
export const deriveDialog = (page) => page.getByRole('dialog', { name: /Derivar esta conversación/ })
export const deriveConfirm = (page) => deriveDialog(page).getByRole('button', { name: 'Derivar', exact: true })
