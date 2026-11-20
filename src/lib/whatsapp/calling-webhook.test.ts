import { describe, expect, it } from 'vitest'
import {
  parseWhatsAppCallPermissionReply,
  parseWhatsAppCallingWebhookChange,
  protectWhatsAppCallingWebhookSdp,
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
          from: '51911111111',
          to: '51980942247',
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


describe('protectWhatsAppCallingWebhookSdp', () => {
  it('encrypts SDP and removes plaintext before the durable inbox copy', () => {
    const original = {
      entry: [{
        changes: [{
          field: 'calls',
          value: {
            metadata: { phone_number_id: '740434745820831' },
            calls: [{
              id: 'wacid.call-protect-01',
              event: 'connect',
              timestamp: '1795120000',
              direction: 'USER_INITIATED',
              session: { sdp_type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
            }],
          },
        }],
      }],
    }

    const protectedCopy = protectWhatsAppCallingWebhookSdp(original, (sdp) => 'cipher:' + sdp)
    const session = (protectedCopy as typeof original).entry[0].changes[0].value.calls[0].session

    expect(session.sdp).toBeUndefined()
    expect(session.wacrm_sdp_ciphertext).toContain('cipher:v=0')
    expect(original.entry[0].changes[0].value.calls[0].session.sdp).toContain('v=0')
  })

  it('rejects malformed or oversized SDP instead of persisting plaintext', () => {
    const payload = {
      entry: [{
        changes: [{
          field: 'calls',
          value: {
            calls: [{
              id: 'wacid.call-protect-02',
              session: { sdp_type: 'offer', sdp: 'not-sdp' },
            }],
          },
        }],
      }],
    }
    expect(() => protectWhatsAppCallingWebhookSdp(payload, (sdp) => 'cipher:' + sdp))
      .toThrow(/Invalid Calling SDP/)
  })
})

describe('encrypted Calling SDP parser', () => {
  it('parses the internal ciphertext field without exposing plaintext SDP', () => {
    const parsed = parseWhatsAppCallingWebhookChange({
      field: 'calls',
      value: {
        metadata: { phone_number_id: '740434745820831' },
        calls: [{
          id: 'wacid.call-ciphertext-01',
          event: 'connect',
          timestamp: '1795120000',
          direction: 'USER_INITIATED',
          session: { sdp_type: 'offer', wacrm_sdp_ciphertext: 'ciphertext-only' },
        }],
      },
    })

    expect(parsed?.calls[0]?.session).toEqual({
      sdp_type: 'offer',
      sdpCiphertext: 'ciphertext-only',
    })
    expect(parsed?.calls[0]?.session).not.toHaveProperty('sdp')
  })
})
