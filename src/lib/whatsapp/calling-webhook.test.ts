import { describe, expect, it } from 'vitest'
import {
  parseWhatsAppCallPermissionReply,
  parseWhatsAppCallingWebhookChange,
} from './calling-webhook'

describe('parseWhatsAppCallingWebhookChange', () => {
  it('parses a user-initiated connect offer and retains BSUID identity', () => {
    const parsed = parseWhatsAppCallingWebhookChange({
      field: 'calls',
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '+51 980 942 247',
          phone_number_id: '740434745820831',
        },
        contacts: [{
          profile: { name: 'Cliente', username: 'cliente' },
          wa_id: '51911111111',
          user_id: 'PE.123456789',
          parent_user_id: 'PE.987654321',
        }],
        calls: [{
          id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
          from: '51980942247',
          to: '51911111111',
          event: 'connect',
          timestamp: '1795120000',
          direction: 'USER_INITIATED',
          from_user_id: 'PE.123456789',
          session: { sdp_type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
        }],
      },
    })

    expect(parsed).toMatchObject({
      phoneNumberId: '740434745820831',
      contacts: [{
        wa_id: '51911111111',
        user_id: 'PE.123456789',
        parent_user_id: 'PE.987654321',
        profile: { name: 'Cliente', username: 'cliente' },
      }],
      calls: [{
        id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
        event: 'connect',
        direction: 'USER_INITIATED',
        from_user_id: 'PE.123456789',
        session: { sdp_type: 'offer' },
      }],
    })
  })

  it('parses termination and call-status webhooks without requiring SDP', () => {
    const parsed = parseWhatsAppCallingWebhookChange({
      field: 'calls',
      value: {
        metadata: { phone_number_id: '740434745820831' },
        calls: [{
          id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
          event: 'terminate',
          timestamp: '1795120060',
          direction: 'USER_INITIATED',
          status: 'COMPLETED',
          duration: 60,
          start_time: '1795120000',
          end_time: '1795120060',
        }],
        statuses: [{
          id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
          status: 'ACCEPTED',
          timestamp: '1795120005',
          recipient_id: '51911111111',
          recipient_user_id: 'PE.123456789',
          recipient_parent_user_id: 'PE.987654321',
          type: 'call',
        }],
      },
    })

    expect(parsed?.calls[0]).toMatchObject({
      event: 'terminate',
      status: 'COMPLETED',
      duration: 60,
    })
    expect(parsed?.statuses[0]).toMatchObject({
      status: 'ACCEPTED',
      recipient_id: '51911111111',
      recipient_user_id: 'PE.123456789',
      recipient_parent_user_id: 'PE.987654321',
      type: 'call',
    })
  })

  it('fails closed for unrelated, malformed or unrouteable webhook changes', () => {
    expect(parseWhatsAppCallingWebhookChange({ field: 'messages', value: {} })).toBeNull()
    expect(parseWhatsAppCallingWebhookChange({ field: 'calls', value: {} })).toBeNull()
    expect(parseWhatsAppCallingWebhookChange({
      field: 'calls',
      value: { metadata: { phone_number_id: 'not-an-id' }, calls: [{ id: 'x', event: 'connect', timestamp: '1' }] },
    })).toBeNull()
    expect(parseWhatsAppCallingWebhookChange({
      field: 'calls',
      value: {
        metadata: { phone_number_id: '740434745820831' },
        calls: [{ id: '', event: 'connect', timestamp: '1' }],
      },
    })).toBeNull()
  })
})

describe('parseWhatsAppCallPermissionReply', () => {
  it('parses a temporary permission approval and preserves its expiry', () => {
    const parsed = parseWhatsAppCallPermissionReply({
      id: 'wamid.permission-reply',
      from: '51911111111',
      from_user_id: 'PE.123456789',
      timestamp: '1795120000',
      type: 'interactive',
      context: { id: 'wamid.permission-request' },
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: {
          response: 'accept',
          is_permanent: false,
          expiration_timestamp: '1795724800',
          response_source: 'user_action',
        },
      },
    })

    expect(parsed).toEqual({
      response: 'accept',
      is_permanent: false,
      expiration_timestamp: '1795724800',
      response_source: 'user_action',
      from: '51911111111',
      from_user_id: 'PE.123456789',
      message_id: 'wamid.permission-reply',
      timestamp: '1795120000',
      context_message_id: 'wamid.permission-request',
    })
  })

  it('parses a permanent approval and a rejection', () => {
    expect(parseWhatsAppCallPermissionReply({
      type: 'interactive',
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: { response: 'accept', is_permanent: true, response_source: 'user_action' },
      },
    })).toMatchObject({ response: 'accept', is_permanent: true })

    expect(parseWhatsAppCallPermissionReply({
      type: 'interactive',
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: { response: 'reject', response_source: 'user_action' },
      },
    })).toMatchObject({ response: 'reject' })
  })

  it('ignores messages that are not valid call-permission replies', () => {
    expect(parseWhatsAppCallPermissionReply({ type: 'text' })).toBeNull()
    expect(parseWhatsAppCallPermissionReply({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'x' } },
    })).toBeNull()
    expect(parseWhatsAppCallPermissionReply({
      type: 'interactive',
      interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'maybe' } },
    })).toBeNull()
  })
})
