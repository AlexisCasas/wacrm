/**
 * CALL-03 pilot guard. Calling is disabled unless the server-side feature
 * switch, business-number allowlist and the one approved customer identity
 * all match. Never trust a browser-supplied phone or phone_number_id.
 */
export const CALLING_PILOT_PHONE_NUMBER_ID = '740434745820831'
export const CALLING_PILOT_CUSTOMER_PHONE = '51980942247'

function normalizedDigits(value: string): string {
  return value.replace(/\D/g, '')
}

export function isWhatsAppCallingPilotAllowed(
  phoneNumberId: string,
  customerPhone: string | null | undefined,
): boolean {
  if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') return false
  if (phoneNumberId !== CALLING_PILOT_PHONE_NUMBER_ID) return false
  const rawCustomerPhone = customerPhone?.trim() ?? ''
  if (!/^\\+?\\d{6,20}$/.test(rawCustomerPhone)) return false
  if (normalizedDigits(rawCustomerPhone) !== CALLING_PILOT_CUSTOMER_PHONE) return false

  const configuredNumbers = (process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const configuredCustomers = (process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES ?? '')
    .split(',')
    .map(normalizedDigits)
    .filter(Boolean)

  return configuredNumbers.includes(CALLING_PILOT_PHONE_NUMBER_ID)
    && configuredCustomers.includes(CALLING_PILOT_CUSTOMER_PHONE)
}
