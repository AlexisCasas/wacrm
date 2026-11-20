import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCallWebhook,
  isControlTokenValid,
  isValidSdp,
  signWebhookPayload,
} from './server.mjs'

test('signWebhookPayload returns Meta-compatible sha256 HMAC header', () => {
  const signature = signWebhookPayload('{"ok":true}', 'qa-secret-for-unit-test')
  assert.match(signature, /^sha256=[a-f0-9]{64}$/)
})

test('buildCallWebhook creates a routable synthetic calls change', () => {
  const payload = buildCallWebhook({
    phoneNumberId: '740434745820831',
    wabaId: 'QA-SYNTHETIC-WABA',
    displayPhone: '+51 980 000 000',
    customerPhone: '51980942247',
    calls: [{
      id: 'wacid.qa-unit-test',
      event: 'connect',
      timestamp: '1795200000',
      direction: 'BUSINESS_INITIATED',
      to: '51980942247',
      session: { sdp_type: 'answer', sdp: 'v=0\r\ns=qa\r\n' },
    }],
  })
  assert.equal(payload.object, 'whatsapp_business_account')
  assert.equal(payload.entry[0].id, 'QA-SYNTHETIC-WABA')
  const change = payload.entry[0].changes[0]
  assert.equal(change.field, 'calls')
  assert.equal(change.value.metadata.phone_number_id, '740434745820831')
  assert.equal(change.value.calls[0].session.sdp_type, 'answer')
})

test('buildCallWebhook supports synthetic call status changes', () => {
  const payload = buildCallWebhook({
    phoneNumberId: '740434745820831',
    wabaId: 'QA-SYNTHETIC-WABA',
    displayPhone: '+51 980 000 000',
    customerPhone: '51980942247',
    statuses: [{
      id: 'wacid.qa-unit-test',
      status: 'ACCEPTED',
      timestamp: '1795200000',
      recipient_id: '51980942247',
      type: 'call',
    }],
  })
  assert.equal(payload.entry[0].changes[0].value.statuses[0].status, 'ACCEPTED')
})

test('control token comparison rejects missing, wrong and unequal-length values', () => {
  assert.equal(isControlTokenValid(undefined, 'a'.repeat(32)), false)
  assert.equal(isControlTokenValid('b'.repeat(32), 'a'.repeat(32)), false)
  assert.equal(isControlTokenValid('short', 'a'.repeat(32)), false)
  assert.equal(isControlTokenValid('a'.repeat(32), 'a'.repeat(32)), true)
})

test('SDP validation accepts only bounded offer/answer SDP strings', () => {
  assert.equal(isValidSdp('v=0\r\ns=qa\r\n', 'offer'), true)
  assert.equal(isValidSdp('v=0\r\ns=qa\r\n', 'answer'), true)
  assert.equal(isValidSdp('not-sdp', 'offer'), false)
  assert.equal(isValidSdp('', 'offer'), false)
  assert.equal(isValidSdp('v=0\r\n' + 'x'.repeat(65_537), 'offer'), false)
})
