import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 128 * 1024
const CALL_ID_PREFIX = 'wacid.qa-'

export function signWebhookPayload(rawBody, secret) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

export function isControlTokenValid(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function isValidSdp(value, expectedType) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 65_536
    && /^v=0(?:\r?\n)/.test(value)
    && (expectedType === 'offer' || expectedType === 'answer')
}

export function buildCallWebhook({
  phoneNumberId,
  wabaId,
  displayPhone,
  customerPhone,
  calls = [],
  statuses = [],
}) {
  const value = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: displayPhone,
      phone_number_id: phoneNumberId,
    },
    contacts: [{
      profile: { name: 'QA Synthetic Peer' },
      wa_id: customerPhone,
    }],
    ...(calls.length ? { calls } : {}),
    ...(statuses.length ? { statuses } : {}),
  }
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{ field: 'calls', value }],
    }],
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function html(res, value) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(value)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request_body_too_large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json_object')
  return value
}

export function createCallStore() {
  const calls = new Map()
  return {
    create({ direction, offer, callbackData = null }) {
      const id = CALL_ID_PREFIX + randomUUID()
      const call = {
        id,
        direction,
        state: direction === 'USER_INITIATED' ? 'offered' : 'waiting-peer',
        offer,
        remoteAnswer: null,
        agentAnswer: null,
        callbackData,
        createdAt: new Date().toISOString(),
        acceptedAt: null,
        endedAt: null,
        graphActionCounts: { pre_accept: 0, accept: 0, reject: 0, terminate: 0 },
      }
      calls.set(id, call)
      return call
    },
    get(id) {
      return calls.get(id) ?? null
    },
    list() {
      return [...calls.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },
  }
}

/**
 * One-shot, per-call QA fault. There is no global failure mode and it never
 * affects other synthetic calls. State expires after 120 seconds; disabled
 * unless the operator enables MOCK_FAULT_INJECTION_ENABLED on QA only.
 */
export function createFaultStore() {
  const armed = new Map()
  return {
    arm(callId, action) {
      if (armed.has(callId)) return false
      armed.set(callId, { action, expiresAt: Date.now() + 120_000 })
      return true
    },
    consume(callId, action) {
      const fault = armed.get(callId)
      if (!fault) return false
      if (fault.expiresAt <= Date.now()) {
        armed.delete(callId)
        return false
      }
      if (fault.action !== action) return false
      armed.delete(callId)
      return true
    },
  }
}

export function assertQaEnvironment(env) {
  if (env.MOCK_ENVIRONMENT !== 'qa' || env.MOCK_GRAPH_ENABLED !== 'true') {
    throw new Error('mock_graph_requires_explicit_qa_enablement')
  }
  if (env.MOCK_PHONE_NUMBER_ID !== '740434745820831'
    || env.MOCK_CUSTOMER_PHONE !== '51980942247'
    || env.MOCK_WABA_ID !== 'QA-SYNTHETIC-WABA') {
    throw new Error('mock_graph_pilot_identity_mismatch')
  }
  if (!env.MOCK_META_APP_SECRET || env.MOCK_META_APP_SECRET.length < 32) {
    throw new Error('mock_graph_requires_new_qa_webhook_secret')
  }
  if (typeof env.MOCK_CONTROL_TOKEN !== 'string'
    || !/^[A-Za-z0-9_-]{32,128}$/.test(env.MOCK_CONTROL_TOKEN)) {
    throw new Error('mock_graph_requires_url_safe_local_control_token')
  }
  const webhook = new URL(env.WACRM_WEBHOOK_URL ?? '')
  if (webhook.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(webhook.hostname)
    || webhook.port !== '3000' || webhook.pathname !== '/api/whatsapp/webhook') {
    throw new Error('mock_graph_webhook_must_target_local_qa_app')
  }
}

function createWebhookSender({ env, fetchImpl }) {
  return async (payload) => {
    const rawBody = JSON.stringify(payload)
    const response = await fetchImpl(env.WACRM_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWebhookPayload(rawBody, env.MOCK_META_APP_SECRET),
      },
      body: rawBody,
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error('qa_webhook_delivery_failed_' + response.status)
    return response.status
  }
}

function safeCall(call) {
  if (!call) return null
  return {
    id: call.id,
    direction: call.direction,
    state: call.state,
    offer: call.offer,
    remoteAnswer: call.remoteAnswer,
    agentAnswer: call.agentAnswer,
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt,
    endedAt: call.endedAt,
    graphActionCounts: { ...call.graphActionCounts },
  }
}

// Meta reports start_time, end_time and duration on terminate only for calls
// that were actually connected. Rejected or unanswered calls carry end_time only.
export function terminateTiming(call, endSeconds) {
  const timing = { end_time: String(endSeconds) }
  if (!call.acceptedAt) return timing
  const startSeconds = Math.floor(Date.parse(call.acceptedAt) / 1000)
  if (!Number.isFinite(startSeconds) || startSeconds > endSeconds) return timing
  return { start_time: String(startSeconds), ...timing, duration: endSeconds - startSeconds }
}

export function createCallEvent(call, env, event, extra = {}) {
  // Meta's Calling webhook identifies the business phone as "from" and
  // the WhatsApp user/callee as "to" for both call directions.
  const businessPhone = (env.MOCK_DISPLAY_PHONE ?? '+51 980 000 000').replace(/\D/g, '')
  return {
    id: call.id,
    event,
    timestamp: String(Math.floor(Date.now() / 1000)),
    direction: call.direction,
    from: businessPhone,
    to: env.MOCK_CUSTOMER_PHONE,
    ...(call.callbackData ? { biz_opaque_callback_data: call.callbackData } : {}),
    ...extra,
  }
}

function createStatus(call, env, status) {
  return {
    id: call.id,
    status,
    timestamp: String(Math.floor(Date.now() / 1000)),
    recipient_id: env.MOCK_CUSTOMER_PHONE,
    type: 'call',
    ...(call.callbackData ? { biz_opaque_callback_data: call.callbackData } : {}),
  }
}

export function createGraphHandler({ env, calls, faults = createFaultStore(), fetchImpl = fetch, log = console.log }) {
  const sendWebhook = createWebhookSender({ env, fetchImpl })
  const respondAfterEffect = (res, call, action) => {
    // A committed Graph effect followed by an HTTP 503 is intentionally
    // ambiguous for WACRM: it must persist unknown and NEVER retry blindly.
    if (faults.consume(call.id, action)) {
      log('[mock-graph] QA one-shot post-effect 503 for ' + action)
      return json(res, 503, { error: { message: 'QA simulated uncertain Graph result', code: 1 } })
    }
    return json(res, 200, { success: true })
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://graph.facebook.com')
    log('[mock-graph] ' + req.method + ' ' + url.pathname)

    const parts = url.pathname.split('/').filter(Boolean)
    const [, phoneNumberId, resource] = parts

    if (req.method === 'GET' && resource === 'call_permissions'
      && phoneNumberId === env.MOCK_PHONE_NUMBER_ID) {
      const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
      return json(res, 200, {
        permission: { status: 'temporary', expiration_time: expires },
        actions: [
          { action_name: 'start_call', can_perform_action: true, limits: [] },
          { action_name: 'send_call_permission_request', can_perform_action: true, limits: [] },
        ],
      })
    }

    if (req.method === 'POST' && resource === 'calls'
      && phoneNumberId === env.MOCK_PHONE_NUMBER_ID) {
      let body
      try { body = await readJson(req) } catch {
        return json(res, 400, { error: { message: 'Invalid mock request body', code: 100 } })
      }

      const action = body.action
      if (action === 'connect') {
        if (body.session?.sdp_type !== 'offer' || !isValidSdp(body.session?.sdp, 'offer')) {
          return json(res, 400, { error: { message: 'A valid SDP offer is required', code: 100 } })
        }
        const call = calls.create({
          direction: 'BUSINESS_INITIATED',
          offer: body.session.sdp,
          callbackData: typeof body.biz_opaque_callback_data === 'string'
            ? body.biz_opaque_callback_data : null,
        })
        return json(res, 200, { calls: [{ id: call.id }] })
      }

      const callId = typeof body.call_id === 'string' ? body.call_id : ''
      const call = calls.get(callId)
      if (!call) return json(res, 404, { error: { message: 'Synthetic call not found', code: 100 } })

      if (action === 'pre_accept') {
        if (call.direction !== 'USER_INITIATED'
          || body.session?.sdp_type !== 'answer'
          || !isValidSdp(body.session?.sdp, 'answer')) {
          return json(res, 400, { error: { message: 'A valid inbound SDP answer is required', code: 100 } })
        }
        call.agentAnswer = body.session.sdp
        call.state = 'preaccepted'
        call.graphActionCounts.pre_accept++
        return respondAfterEffect(res, call, 'pre_accept')
      }

      if (action === 'accept') {
        if (call.direction !== 'USER_INITIATED' || !call.agentAnswer) {
          return json(res, 409, { error: { message: 'Inbound call has not completed pre_accept', code: 100 } })
        }
        call.state = 'connected'
        call.acceptedAt = new Date().toISOString()
        call.graphActionCounts.accept++
        // UIC acceptance is represented by the terminate timing fields.
        // Do not synthesize a separate ACCEPTED status absent from the UIC contract.
        return respondAfterEffect(res, call, 'accept')
      }

      if (action === 'reject' || action === 'terminate') {
        const rejected = action === 'reject'
        call.state = rejected ? 'rejected' : 'terminated'
        call.endedAt = new Date().toISOString()
        call.graphActionCounts[action]++
        try {
          await sendWebhook(buildCallWebhook({
            phoneNumberId: env.MOCK_PHONE_NUMBER_ID,
            wabaId: env.MOCK_WABA_ID,
            displayPhone: env.MOCK_DISPLAY_PHONE ?? '+51 980 000 000',
            customerPhone: env.MOCK_CUSTOMER_PHONE,
            calls: [createCallEvent(call, env, 'terminate', {
              status: rejected ? 'REJECTED' : 'COMPLETED',
              ...terminateTiming(call, Math.floor(Date.now() / 1000)),
            })],
          }))
        } catch {
          return json(res, 502, { error: { message: 'QA webhook delivery failed', code: 1 } })
        }
        return respondAfterEffect(res, call, action)
      }

      return json(res, 400, { error: { message: 'Unsupported synthetic Calling action', code: 100 } })
    }

    if (req.method === 'POST' && resource === 'messages'
      && phoneNumberId === env.MOCK_PHONE_NUMBER_ID) {
      const id = 'wamid.qa-' + randomUUID()
      return json(res, 200, { messages: [{ id }] })
    }

    if (req.method === 'GET' && parts.length === 2 && parts[1] === env.MOCK_WABA_ID) {
      return json(res, 400, { error: { message: 'WABA analytics endpoint is not simulated', code: 100 } })
    }

    return json(res, 400, { error: { message: 'Endpoint not simulated by the QA Graph mock', code: 100 } })
  }
}

export function createPeerHandler({ env, calls, faults = createFaultStore(), fetchImpl = fetch, peerHtml, log = console.log }) {
  const sendWebhook = createWebhookSender({ env, fetchImpl })
  const authorized = (req) => isControlTokenValid(req.headers['x-qa-mock-token'], env.MOCK_CONTROL_TOKEN)

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:38090')
    log('[mock-peer] ' + req.method + ' ' + url.pathname)

    if (req.method === 'GET' && url.pathname === '/qa/health') {
      return json(res, 200, { ok: true, mode: 'qa' })
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/peer')) {
      return html(res, peerHtml.replaceAll('__QA_CONTROL_TOKEN__', env.MOCK_CONTROL_TOKEN))
    }
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized QA peer control' })

    // Fault control is off by default, token protected, per-existing-call and
    // one-shot. It never exposes any production Meta endpoint.
    if (req.method === 'POST' && url.pathname === '/qa/faults') {
      if (env.MOCK_FAULT_INJECTION_ENABLED !== 'true') {
        return json(res, 403, { error: 'QA fault injection disabled' })
      }
      let body
      try { body = await readJson(req) } catch {
        return json(res, 400, { error: 'Invalid QA fault payload' })
      }
      if (body.mode !== 'after_effect_503'
        || !['pre_accept','accept','reject','terminate'].includes(body.action)
        || typeof body.call_id !== 'string'
        || !/^wacid\.qa-[a-f0-9-]{36}$/.test(body.call_id)) {
        return json(res, 400, { error: 'Invalid synthetic fault request' })
      }
      if (!calls.get(body.call_id)) return json(res, 404, { error: 'Synthetic call not found' })
      if (!faults.arm(body.call_id, body.action)) {
        return json(res, 409, { error: 'A one-shot fault is already armed for this synthetic call' })
      }
      return json(res, 201, {
        armed: true, call_id: body.call_id, action: body.action,
        mode: 'after_effect_503', expires_in_seconds: 120,
      })
    }

    if (req.method === 'GET' && url.pathname === '/qa/calls') {
      return json(res, 200, { calls: calls.list().map(safeCall) })
    }

    if (req.method === 'POST' && url.pathname === '/qa/incoming') {
      let body
      try { body = await readJson(req) } catch {
        return json(res, 400, { error: 'Invalid JSON body' })
      }
      if (!isValidSdp(body.offer, 'offer')) return json(res, 400, { error: 'A valid SDP offer is required' })
      const call = calls.create({ direction: 'USER_INITIATED', offer: body.offer })
      try {
        await sendWebhook(buildCallWebhook({
          phoneNumberId: env.MOCK_PHONE_NUMBER_ID,
          wabaId: env.MOCK_WABA_ID,
          displayPhone: env.MOCK_DISPLAY_PHONE ?? '+51 980 000 000',
          customerPhone: env.MOCK_CUSTOMER_PHONE,
          calls: [createCallEvent(call, env, 'connect', {
            session: { sdp_type: 'offer', sdp: body.offer },
          })],
        }))
      } catch {
        call.state = 'webhook-failed'
        return json(res, 502, { error: 'Could not deliver synthetic incoming call webhook' })
      }
      return json(res, 201, { call_id: call.id, state: call.state })
    }

    const answerMatch = url.pathname.match(/^\/qa\/calls\/(wacid\.qa-[A-Fa-f0-9-]+)\/answer$/)
    if (req.method === 'POST' && answerMatch) {
      const call = calls.get(answerMatch[1])
      if (!call || call.direction !== 'BUSINESS_INITIATED') return json(res, 404, { error: 'Outbound synthetic call not found' })
      let body
      try { body = await readJson(req) } catch {
        return json(res, 400, { error: 'Invalid JSON body' })
      }
      if (!isValidSdp(body.answer, 'answer')) return json(res, 400, { error: 'A valid SDP answer is required' })
      call.remoteAnswer = body.answer
      call.state = 'answer-submitted'
      try {
        await sendWebhook(buildCallWebhook({
          phoneNumberId: env.MOCK_PHONE_NUMBER_ID,
          wabaId: env.MOCK_WABA_ID,
          displayPhone: env.MOCK_DISPLAY_PHONE ?? '+51 980 000 000',
          customerPhone: env.MOCK_CUSTOMER_PHONE,
          calls: [createCallEvent(call, env, 'connect', {
            session: { sdp_type: 'answer', sdp: body.answer },
          })],
        }))
      } catch {
        return json(res, 502, { error: 'Could not deliver synthetic outbound answer webhook' })
      }
      return json(res, 200, { success: true })
    }

    const connectedMatch = url.pathname.match(/^\/qa\/calls\/(wacid\.qa-[A-Fa-f0-9-]+)\/peer-connected$/)
    if (req.method === 'POST' && connectedMatch) {
      const call = calls.get(connectedMatch[1])
      if (!call || call.direction !== 'BUSINESS_INITIATED') return json(res, 404, { error: 'Outbound synthetic call not found' })
      if (call.state !== 'connected') {
        call.state = 'connected'
        call.acceptedAt = new Date().toISOString()
        try {
          await sendWebhook(buildCallWebhook({
            phoneNumberId: env.MOCK_PHONE_NUMBER_ID,
            wabaId: env.MOCK_WABA_ID,
            displayPhone: env.MOCK_DISPLAY_PHONE ?? '+51 980 000 000',
            customerPhone: env.MOCK_CUSTOMER_PHONE,
            statuses: [createStatus(call, env, 'ACCEPTED')],
          }))
        } catch {
          return json(res, 502, { error: 'Could not deliver synthetic connected status' })
        }
      }
      return json(res, 200, { success: true })
    }

    const disconnectMatch = url.pathname.match(/^\/qa\/calls\/(wacid\.qa-[A-Fa-f0-9-]+)\/peer-disconnect$/)
    if (req.method === 'POST' && disconnectMatch) {
      const call = calls.get(disconnectMatch[1])
      if (!call) return json(res, 404, { error: 'Synthetic call not found' })
      call.state = 'peer-disconnected'
      return json(res, 200, { success: true })
    }

    const callMatch = url.pathname.match(/^\/qa\/calls\/(wacid\.qa-[A-Fa-f0-9-]+)$/)
    if (req.method === 'GET' && callMatch) {
      const call = calls.get(callMatch[1])
      return call ? json(res, 200, { call: safeCall(call) }) : json(res, 404, { error: 'Synthetic call not found' })
    }

    return json(res, 404, { error: 'Unknown QA peer endpoint' })
  }
}

async function main() {
  assertQaEnvironment(process.env)
  const cert = await readFile(process.env.MOCK_TLS_CERT_FILE)
  const key = await readFile(process.env.MOCK_TLS_KEY_FILE)
  const calls = createCallStore()
  const faults = createFaultStore()
  const peerHtml = await readFile(join(HERE, 'peer.html'), 'utf8')
  const graphHandler = createGraphHandler({ env: process.env, calls, faults })
  const peerHandler = createPeerHandler({ env: process.env, calls, faults, peerHtml })

  const graphServer = createHttpsServer({ cert, key }, (req, res) => {
    void graphHandler(req, res).catch(() => json(res, 500, { error: { message: 'QA mock internal error', code: 1 } }))
  })
  const peerServer = createHttpServer((req, res) => {
    void peerHandler(req, res).catch(() => json(res, 500, { error: 'QA peer internal error' }))
  })

  const graphPort = Number(process.env.MOCK_GRAPH_PORT ?? 443)
  const peerPort = Number(process.env.MOCK_PEER_PORT ?? 38090)
  graphServer.listen(graphPort, '0.0.0.0', () => console.log('[mock-graph] QA TLS mock listening on ' + graphPort))
  peerServer.listen(peerPort, '0.0.0.0', () => console.log('[mock-peer] QA WebRTC peer listening on ' + peerPort))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[mock-graph] startup blocked:', error.message)
    process.exitCode = 1
  })
}
