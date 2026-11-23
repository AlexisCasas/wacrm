/**
 * CALL-03 pilot guard. Calling is disabled unless the server-side feature
 * switch and Keyler's business-number allowlist match. All-contacts mode is
 * a separate private opt-in and keeps the global kill switch intact.
 * Never trust a browser-supplied phone number or phone_number_id.
 */
export const CALLING_PILOT_PHONE_NUMBER_ID = '740434745820831'
// The business number is NOT a customer. Never permit calling itself.
export const CALLING_PILOT_BUSINESS_PHONE = '51980942247'

function normalizedDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/** A webhook-level gate: no Calling writes when OFF or outside pilot number. */
export function isWhatsAppCallingPhoneEnabled(phoneNumberId: string | null | undefined): boolean {
  if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') return false
  if (!phoneNumberId || phoneNumberId !== CALLING_PILOT_PHONE_NUMBER_ID) return false
  const allowed = (process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return allowed.includes(CALLING_PILOT_PHONE_NUMBER_ID)
}

function validBsuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(value)
}

/** Identities must come from the DB scoped by the authenticated account. */
export function isWhatsAppCallingPilotAllowed(
  phoneNumberId: string,
  customerPhone: string | null | undefined,
  customerBsuid?: string | null,
  customerParentBsuid?: string | null,
): boolean {
  if (!isWhatsAppCallingPhoneEnabled(phoneNumberId)) return false

  const rawCustomerPhone = customerPhone?.trim() ?? ''
  const customer = /^\+?\d{6,20}$/.test(rawCustomerPhone)
    ? normalizedDigits(rawCustomerPhone) : null

  // Never call the business itself, including when an additional BSUID exists.
  if (customer === CALLING_PILOT_BUSINESS_PHONE) return false

  if (process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS === 'true') {
    return Boolean(customer || validBsuid(customerBsuid) || validBsuid(customerParentBsuid))
  }

  if (!customer) return false
  const configuredCustomers = (process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES ?? '')
    .split(',')
    .map(normalizedDigits)
    .filter(Boolean)

  // Legacy mode remains restricted to one approved customer by default.
  return configuredCustomers.length === 1 && configuredCustomers[0] === customer
}
