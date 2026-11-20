import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALLING_PILOT_PHONE_NUMBER_ID,
  isWhatsAppCallingPilotAllowed,
} from './calling-pilot'

const originalEnabled = process.env.WHATSAPP_CALLING_ENABLED
const originalAllowlist = process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.WHATSAPP_CALLING_ENABLED
  else process.env.WHATSAPP_CALLING_ENABLED = originalEnabled

  if (originalAllowlist === undefined) delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
  else process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = originalAllowlist
  vi.restoreAllMocks()
})

describe('WhatsApp Calling pilot guard', () => {
  it('fails closed when the feature flag is absent', () => {
    delete process.env.WHATSAPP_CALLING_ENABLED
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(false)
  })

  it('fails closed when the pilot allowlist is absent', () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(false)
  })

  it('allows only the approved Keyler WABA phone_number_id when both server gates are set', () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(true)
    expect(isWhatsAppCallingPilotAllowed('999999999999999')).toBe(false)
  })

  it('does not accept an allowlist entry for a different business phone number', () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = '999999999999999'
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(false)
  })
})
