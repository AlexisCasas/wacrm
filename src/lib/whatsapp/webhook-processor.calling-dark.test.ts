import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as unknown[],
  adminCalls: 0,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    h.adminCalls += 1
    return {}
  },
}))

vi.mock('@/lib/whatsapp/calling-webhook-processor', () => ({
  processCallingWebhookChange: async (_db: unknown, change: unknown) => {
    h.calls.push(change)
    return true
  },
  processCallPermissionReply: async () => false,
}))

import { processWebhook } from './webhook-processor'
import { CALLING_PILOT_PHONE_NUMBER_ID } from './calling-pilot'

const originalFlag = process.env.WHATSAPP_CALLING_ENABLED
const originalNumbers = process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS

function payload(numberId: string) {
  return {
    entry: [{
      id: 'qa-test-waba',
      changes: [{
        field: 'calls',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+51 000000000', phone_number_id: numberId },
        },
      }],
    }],
  }
}

beforeEach(() => {
  h.calls = []
  h.adminCalls = 0
  delete process.env.WHATSAPP_CALLING_ENABLED
  delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
})

afterEach(() => {
  if (originalFlag === undefined) delete process.env.WHATSAPP_CALLING_ENABLED
  else process.env.WHATSAPP_CALLING_ENABLED = originalFlag
  if (originalNumbers === undefined) delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
  else process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = originalNumbers
})

describe('CALL-03 dark webhook release', () => {
  it('drops calls payload when the Calling server flag is absent', async () => {
    await processWebhook(payload(CALLING_PILOT_PHONE_NUMBER_ID))
    expect(h.calls).toHaveLength(0)
    expect(h.adminCalls).toBe(0)
  })

  it('drops calls even if the business number is in the allowlist while flag is OFF', async () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'false'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    await processWebhook(payload(CALLING_PILOT_PHONE_NUMBER_ID))
    expect(h.calls).toHaveLength(0)
    expect(h.adminCalls).toBe(0)
  })

  it('ignores unapproved Calling numbers when pilot flag is ON', async () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    await processWebhook(payload('999999999999999'))
    expect(h.calls).toHaveLength(0)
    expect(h.adminCalls).toBe(0)
  })

  it('processes an allowed Calling number exactly once when pilot flag is ON', async () => {
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = CALLING_PILOT_PHONE_NUMBER_ID
    await processWebhook(payload(CALLING_PILOT_PHONE_NUMBER_ID))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ field: 'calls', value: { metadata: { phone_number_id: CALLING_PILOT_PHONE_NUMBER_ID } } })
    expect(h.adminCalls).toBe(1)
  })
})
