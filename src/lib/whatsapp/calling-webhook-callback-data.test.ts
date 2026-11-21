import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { processCallingWebhookChange } from './calling-webhook-processor'

function makeDb() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const db = {
    from: (table: string) => {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                account_id: 'a3000000-0000-4000-8000-000000000001',
                user_id: 'a3000000-0000-4000-8000-000000000002',
                phone_number_id: '740434745820831',
              },
              error: null,
            }),
          }),
        }),
      }
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: true, error: null }
    }),
  } as unknown as SupabaseClient
  return { db, calls }
}

describe('CALL-03B callback data webhook persistence', () => {
  it('stores callback data echoed by a terminate event', async () => {
    const { db, calls } = makeDb()
    const callbackData = 'a3000000-0000-4000-8000-000000000003'

    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: '740434745820831' },
        calls: [{
          id: 'wacid.qa-callback-terminate',
          event: 'terminate',
          timestamp: '1795120000',
          direction: 'BUSINESS_INITIATED',
          status: 'TERMINATED',
          biz_opaque_callback_data: callbackData,
        }],
      },
    })

    expect(calls.map((call) => call.name)).toEqual([
      'whatsapp_call_event_apply',
      'whatsapp_call_session_callback_data_apply',
    ])
    expect(calls[1].args).toMatchObject({
      p_account_id: 'a3000000-0000-4000-8000-000000000001',
      p_phone_number_id: '740434745820831',
      p_call_id: 'wacid.qa-callback-terminate',
      p_callback_data: callbackData,
    })
  })

  it('stores callback data echoed by a call status event', async () => {
    const { db, calls } = makeDb()
    const callbackData = 'a3000000-0000-4000-8000-000000000004'

    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: '740434745820831' },
        statuses: [{
          id: 'wacid.qa-callback-status',
          status: 'ACCEPTED',
          timestamp: '1795120001',
          recipient_id: '51980942247',
          type: 'call',
          biz_opaque_callback_data: callbackData,
        }],
      },
    })

    expect(calls.map((call) => call.name)).toEqual([
      'whatsapp_call_event_apply',
      'whatsapp_call_session_callback_data_apply',
    ])
    expect(calls[1].args.p_callback_data).toBe(callbackData)
  })
})
