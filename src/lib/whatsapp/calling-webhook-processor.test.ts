import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { processCallPermissionReply, processCallingWebhookChange } from './calling-webhook-processor'

vi.mock('./encryption', () => ({ encrypt: (value: string) => 'encrypted:' + value }))

const config = {
  account_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  phone_number_id: '740434745820831',
}
const rpc = vi.fn()
const db = {
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn().mockResolvedValue({ data: config, error: null }),
      })),
    })),
  })),
  rpc,
} as unknown as SupabaseClient

afterEach(() => vi.clearAllMocks())

describe('CALL-02 Calling webhook persistence', () => {
  it('stores user-initiated connect with encrypted ephemeral SDP and tenant resolved by phone_number_id', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        contacts: [{ profile: { name: 'Cliente' } }],
        calls: [{
          id: 'wacid.call01',
          event: 'connect',
          timestamp: '1795120000',
          direction: 'USER_INITIATED',
          from: '51911111111',
          from_user_id: 'PE.123456789',
          from_parent_user_id: 'PE.parent123',
          session: { sdp_type: 'offer', sdp },
        }],
      },
    })
    expect(db.from).toHaveBeenCalledWith('whatsapp_config')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][0]).toBe('whatsapp_call_event_apply')
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_account_id: config.account_id,
      p_phone_number_id: config.phone_number_id,
      p_state: 'offered',
      p_customer_key: 'PE.123456789',
      p_customer_bsuid: 'PE.123456789',
      p_customer_parent_bsuid: 'PE.parent123',
      p_session_sdp_encrypted: 'encrypted:' + sdp,
      p_session_sdp_type: 'offer',
    })
  })

  it('fails closed when a connect event has no trustworthy direction or customer identity', async () => {
    await expect(processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        calls: [{ id: 'wacid.call-no-direction', event: 'connect', timestamp: '1795120000', to: '51980942247' }],
      },
    })).rejects.toThrow('call_event_missing_customer_identity')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('persists terminate and ignores non-Calling status objects', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        calls: [{
          id: 'wacid.call02',
          event: 'terminate',
          timestamp: '1795120060',
          direction: 'USER_INITIATED',
          from: '51911111111',
          status: 'COMPLETED',
          duration: 60,
        }],
        statuses: [{
          id: 'wamid.message',
          status: 'delivered',
          timestamp: '1795120061',
          type: 'message',
        }],
      },
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_event_name: 'terminate',
      p_state: 'terminated',
      p_duration_seconds: 60,
      p_session_sdp_encrypted: null,
    })
  })

  it('keeps rejected terminal calls distinct from completed calls', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        calls: [{
          id: 'wacid.call-rejected',
          event: 'terminate',
          timestamp: '1795120060',
          direction: 'USER_INITIATED',
          from: '51911111111',
          status: 'REJECTED',
        }],
      },
    })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_state: 'rejected', p_event_name: 'terminate' })
  })


  it('persists call status state together with the recipient phone identity', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        statuses: [{
          id: 'wacid.status-phone',
          status: 'ACCEPTED',
          timestamp: '1795120005',
          recipient_id: '51911111111',
          type: 'call',
        }],
      },
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_event_name: 'status',
      p_state: 'connected',
      p_customer_key: '51911111111',
      p_customer_phone: '51911111111',
      p_customer_bsuid: null,
    })
  })

  it('persists call status state together with the recipient BSUID identity', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: config.phone_number_id },
        statuses: [{
          id: 'wacid.status-bsuid',
          status: 'RINGING',
          timestamp: '1795120006',
          recipient_id: 'PE.123456789',
          type: 'call',
        }],
      },
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_event_name: 'status',
      p_state: 'ringing',
      p_customer_key: 'PE.123456789',
      p_customer_phone: null,
      p_customer_bsuid: 'PE.123456789',
    })
  })

  it('persists an explicit temporary permission with its seven-day expiry', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    const reply = {
      id: 'wamid.permission',
      from: '51911111111',
      from_user_id: 'PE.123456789',
      type: 'interactive',
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: {
          response: 'accept',
          is_permanent: false,
          expiration_timestamp: '1795724800',
          response_source: 'user_action',
        },
      },
    }
    await processCallPermissionReply(db, config, reply)
    expect(rpc.mock.calls[0][0]).toBe('whatsapp_call_permission_upsert')
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_customer_key: 'PE.123456789',
      p_permission_state: 'approved',
      p_permission_type: 'temporary',
      p_response_source: 'user_action',
      p_expires_at: new Date(1795724800 * 1000).toISOString(),
    })
  })

  it('persists permanent permission and rejection without inventing expiry', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await processCallPermissionReply(db, config, {
      from: '51911111111',
      type: 'interactive',
      interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', is_permanent: true } },
    })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_permission_type: 'permanent', p_expires_at: null })
    rpc.mockClear()
    await processCallPermissionReply(db, config, {
      from: '51911111111',
      type: 'interactive',
      interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'reject', response_source: 'automatic' } },
    })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_permission_state: 'rejected', p_permission_type: null, p_expires_at: null, p_response_source: 'automatic' })
  })

  it('fails closed for an accepted temporary permission without an expiry', async () => {
    await expect(processCallPermissionReply(db, config, {
      from: '51911111111',
      type: 'interactive',
      interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', is_permanent: false } },
    })).rejects.toThrow('call_permission_reply_missing_expiry')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails closed when the phone_number_id cannot be mapped to a WACRM tenant', async () => {
    vi.mocked(db.from).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    } as never))
    await expect(processCallingWebhookChange(db, {
      field: 'calls',
      value: {
        metadata: { phone_number_id: '999999999999999' },
        calls: [{ id: 'wacid.orphan', event: 'connect', timestamp: '1795120000', direction: 'USER_INITIATED', from: '51911111111' }],
      },
    })).rejects.toThrow('calling_config_unavailable')
    expect(rpc).not.toHaveBeenCalled()
  })
})
