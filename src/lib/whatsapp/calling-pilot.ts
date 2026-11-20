/**
 * CALL-03 pilot guard. Calling is disabled unless the server-side feature
 * switch is explicitly enabled AND the configured allowlist contains the
 * approved Meta business phone_number_id. Never trust a browser-supplied ID.
 */
export const CALLING_PILOT_PHONE_NUMBER_ID = '740434745820831'

export function isWhatsAppCallingPilotAllowed(phoneNumberId: string): boolean {
  if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') return false
  if (phoneNumberId !== CALLING_PILOT_PHONE_NUMBER_ID) return false

  const configured = (process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return configured.includes(CALLING_PILOT_PHONE_NUMBER_ID)
}
