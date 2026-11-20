import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  assertQaEnvironment,
  buildCallWebhook,
  createCallStore,
  createGraphHandler,
  createPeerHandler,
  isControlTokenValid,
  isValidSdp,
  signWebhookPayload,
} from './server.mjs'

const env = {
  MOCK_ENVIRONMENT: 'qa',
  MOCK_GRAPH_ENABLED: 'true',
  MOCK_PHONE_NUMBER_ID: '740434745820831',
  MOCK_CUSTOMER_PHONE: '51980942247',
  MOCK_WABA_ID: 'QA-SYNTHETIC-WABA',
  MOCK_META_APP_SECRET: 'qa-only-webhook-secret-'.padEnd(40, 'x'),
  MOCK_CONTROL_TOKEN: 'qa-only-control-token-'.padEnd(40, 'y'),
  WACRM_WEBHOOK_URL: 'http://127.0.0.1:3000/api/whatsapp/webhook',
}

const offer = 'v=0\r\ns=synthetic offer\r\n'
const answer = 'v=0\r\ns=synthetic answer\r\n'

async function invoke(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = headers
  let statusCode = 0
  let responseHeaders = {}
  let responseBody = ''
  const res = {
    writeHead(code, values = {}) {
      statusCode = code
      responseHeaders = values
    },
    end(value = '') {
      responseBody += String(value)
    },
  }
  await handler(req, res)
  const contentType = String(responseHeaders['content-type'] ?? responseHeaders['Content-Type'] ?? '')
  let parsedBody = null
  if (responseBody && contentType.includes('application/json')) {
    try { parsedBody = JSON.parse(responseBody) } catch { parsedBody = null }
  }
  return {
    statusCode,
    headers: responseHeaders,
    body: parsedBody,
    text: responseBody,
  }
}

test('QA safety guard rejects non-QA and non-loopback webhook targets', () => {
  assert.doesNotThrow(() => assertQaEnvironment(env))
  assert.throws(() => assertQaEnvironment({ ...env, MOCK_ENVIRONMENT: 'production' }), /explicit_qa_enablement/)
  assert.throws(() => assertQaEnvironment({
    ...env,
    WACRM_WEBHOOK_URL: 'https://crm.globaltechup.com/api/whatsapp/webhook',
  }), /must_target_local_qa_app/)
})

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
      session: { sdp_type: 'answer', sdp: answer },
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
  assert.equal(isValidSdp(offer, 'offer'), true)
  assert.equal(isValidSdp(answer, 'answer'), true)
  assert.equal(isValidSdp('not-sdp', 'offer'), false)
  assert.equal(isValidSdp('', 'offer'), false)
  assert.equal(isValidSdp('v=0\r\n' + 'x'.repeat(65_537), 'offer'), false)
})

test('Graph mock returns synthetic permission and creates an outbound call ID', async () => {
  const calls = createCallStore()
  const handler = createGraphHandler({ env, calls, fetchImpl: async () => ({ ok: true, status: 200 }), log: () => {} })
  const permission = await invoke(handler, {
    method: 'GET',
    url: '/v27.0/740434745820831/call_permissions?user_wa_id=51980942247',
  })
  assert.equal(permission.statusCode, 200)
  assert.equal(permission.body.permission.status, 'temporary')
  assert.equal(permission.body.actions.find(item => item.action_name === 'start_call').can_perform_action, true)

  const connected = await invoke(handler, {
    method: 'POST',
    url: '/v27.0/740434745820831/calls',
    body: {
      action: 'connect',
      to: '51980942247',
      biz_opaque_callback_data: 'qa-request-1',
      session: { sdp_type: 'offer', sdp: offer },
    },
  })
  assert.equal(connected.statusCode, 200)
  assert.match(connected.body.calls[0].id, /^wacid\.qa-/)
  assert.equal(calls.get(connected.body.calls[0].id).direction, 'BUSINESS_INITIATED')
})

test('Graph mock pre_accept and accept deliver a signed local status webhook', async () => {
  const calls = createCallStore()
  const call = calls.create({ direction: 'USER_INITIATED', offer })
  let delivered = null
  const handler = createGraphHandler({
    env,
    calls,
    fetchImpl: async (url, init) => {
      delivered = { url, init, body: JSON.parse(init.body) }
      return { ok: true, status: 200 }
    },
    log: () => {},
  })

  const preAccept = await invoke(handler, {
    method: 'POST',
    url: '/v27.0/740434745820831/calls',
    body: { action: 'pre_accept', call_id: call.id, session: { sdp_type: 'answer', sdp: answer } },
  })
  assert.equal(preAccept.statusCode, 200)
  assert.equal(call.agentAnswer, answer)

  const accepted = await invoke(handler, {
    method: 'POST',
    url: '/v27.0/740434745820831/calls',
    body: { action: 'accept', call_id: call.id },
  })
  assert.equal(accepted.statusCode, 200)
  assert.equal(delivered.url, env.WACRM_WEBHOOK_URL)
  assert.equal(delivered.body.entry[0].changes[0].value.statuses[0].status, 'ACCEPTED')
  assert.equal(
    delivered.init.headers['x-hub-signature-256'],
    signWebhookPayload(delivered.init.body, env.MOCK_META_APP_SECRET),
  )
})

test('peer control requires token and signs synthetic incoming call webhooks', async () => {
  const calls = createCallStore()
  let delivered = null
  const handler = createPeerHandler({
    env,
    calls,
    peerHtml: '<html>__QA_CONTROL_TOKEN__</html>',
    fetchImpl: async (url, init) => {
      delivered = { url, init, body: JSON.parse(init.body) }
      return { ok: true, status: 200 }
    },
    log: () => {},
  })

  const denied = await invoke(handler, { method: 'GET', url: '/qa/calls' })
  assert.equal(denied.statusCode, 401)

  const page = await invoke(handler, { method: 'GET', url: '/peer' })
  assert.equal(page.statusCode, 200)
  assert.match(String(page.headers['content-type']), /^text\/html/)
  assert.ok(page.text.includes(env.MOCK_CONTROL_TOKEN))

  const incoming = await invoke(handler, {
    method: 'POST',
    url: '/qa/incoming',
    headers: { 'x-qa-mock-token': env.MOCK_CONTROL_TOKEN },
    body: { offer },
  })
  assert.equal(incoming.statusCode, 201)
  assert.match(incoming.body.call_id, /^wacid\.qa-/)
  assert.equal(delivered.url, env.WACRM_WEBHOOK_URL)
  assert.equal(delivered.body.entry[0].changes[0].value.calls[0].direction, 'USER_INITIATED')
  assert.equal(
    delivered.init.headers['x-hub-signature-256'],
    signWebhookPayload(delivered.init.body, env.MOCK_META_APP_SECRET),
  )
})
