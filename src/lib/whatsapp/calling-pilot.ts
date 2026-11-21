/**
 * CALL-03 pilot guard. Calling is disabled unless the server-side feature
 * switch, business-number allowlist and exact pilot customer allowlist match.
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

export function isWhatsAppCallingPilotAllowed(
  phoneNumberId: string,
  customerPhone: string | null | undefined,
): boolean {
  if (!isWhatsAppCallingPhoneEnabled(phoneNumberId)) return false

  const rawCustomerPhone = customerPhone?.trim() ?? ''
  if (!/^\+?\d{6,20}$/.test(rawCustomerPhone)) return false
  const customer = normalizedDigits(rawCustomerPhone)
  if (customer === CALLING_PILOT_BUSINESS_PHONE) return false

  const configuredCustomers = (process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES ?? '')
    .split(',')
    .map(normalizedDigits)
    .filter(Boolean)

  // Single pre-approved real test contact only. No wildcard and no multi-contact pilot.
  return configuredCustomers.length === 1 && configuredCustomers[0] === customer
}
