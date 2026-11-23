import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALLING_PILOT_BUSINESS_PHONE,
  CALLING_PILOT_PHONE_NUMBER_ID,
  isWhatsAppCallingPilotAllowed,
  isWhatsAppCallingPhoneEnabled,
} from './calling-pilot'

const TEST_CUSTOMER_PHONE = '51911122233' // synthetic real-format test recipient

const originalEnabled = process.env.WHATSAPP_CALLING_ENABLED
const originalNumberAllowlist = process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
const originalCustomerAllowlist = process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES
const originalAllContacts = process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.WHATSAPP_CALLING_ENABLED
  else process.env.WHATSAPP_CALLING_ENABLED = originalEnabled

  if (originalNumberAllowlist === undefined) delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
  else process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = originalNumberAllowlist

  if (originalCustomerAllowlist === undefined) delete process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES
  else process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = originalCustomerAllowlist
  if (originalAllContacts === undefined) delete process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS
  else process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = originalAllContacts
  vi.restoreAllMocks()
})

function enablePilot() {
  delete process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS
  process.env.WHATSAPP_CALLING_ENABLED = 'true'
  process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
  process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = TEST_CUSTOMER_PHONE
}

describe('WhatsApp Calling pilot guard', () => {
  it('blocks webhook-side Calling events by default without affecting normal messages', () => {
    delete process.env.WHATSAPP_CALLING_ENABLED
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    expect(isWhatsAppCallingPhoneEnabled(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(false)
  })

  it('requires an exact allowlisted business number for the Calling webhook', () => {
    enablePilot()
    expect(isWhatsAppCallingPhoneEnabled(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(true)
    expect(isWhatsAppCallingPhoneEnabled('999999999999999')).toBe(false)
    expect(isWhatsAppCallingPhoneEnabled(null)).toBe(false)
    expect(isWhatsAppCallingPhoneEnabled(undefined)).toBe(false)
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = ''
    expect(isWhatsAppCallingPhoneEnabled(CALLING_PILOT_PHONE_NUMBER_ID)).toBe(false)
  })

  it('fails closed when the feature flag is absent', () => {
    delete process.env.WHATSAPP_CALLING_ENABLED
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = TEST_CUSTOMER_PHONE
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(false)
  })

  it('fails closed when the business phone-number allowlist is absent', () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
    process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = TEST_CUSTOMER_PHONE
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(false)
  })

  it('fails closed when the customer allowlist is absent', () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    delete process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(false)
  })

  it('allows only one approved customer of Keyler, never an unrelated business number', () => {
    enablePilot()
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(true)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, '+51 980 000 000')).toBe(false)
    expect(isWhatsAppCallingPilotAllowed('999999999999999', TEST_CUSTOMER_PHONE)).toBe(false)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, null)).toBe(false)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, CALLING_PILOT_BUSINESS_PHONE)).toBe(false)
  })

  it('rejects malformed customer numbers and mismatched allowlist entries', () => {
    enablePilot()
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, 'abc')).toBe(false)
    process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = '+51 980 000 000'
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(false)
    process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = `${TEST_CUSTOMER_PHONE},51900099999`
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, TEST_CUSTOMER_PHONE)).toBe(false)
  })
  it('allows all Keyler contacts only with the private all-contacts switch', () => {
    enablePilot()
    process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, '51911122233')).toBe(true)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, '51933344455')).toBe(true)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, null, 'bsuid_test_1')).toBe(true)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, null, null, 'parent_bsuid_1')).toBe(true)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, null)).toBe(false)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, 'abc')).toBe(false)
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, CALLING_PILOT_BUSINESS_PHONE, 'bsuid_test_1')).toBe(false)
    expect(isWhatsAppCallingPilotAllowed('999999999999999', '51911122233')).toBe(false)
  })

  it('fails closed when either global or business switch is OFF', () => {
    enablePilot()
    process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = 'true'
    delete process.env.WHATSAPP_CALLING_ENABLED
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, '51911122233')).toBe(false)
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
    expect(isWhatsAppCallingPilotAllowed(CALLING_PILOT_PHONE_NUMBER_ID, '51911122233')).toBe(false)
  })

})
