import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ForbiddenError } from '@/lib/auth/account'

const assertAccess = vi.fn()
vi.mock('@/lib/conversations/operational-access', () => ({ assertConversationOperationalAccess: (...a: unknown[]) => assertAccess(...a) }))

import { classifySendError, resolveDispatch, sendPackagingTemplate, startPackaging } from '@/lib/orders/logistics/packaging'
import { buildTemplateBodyParams, EMPTY_PARAM_FALLBACK, sanitizeParam } from '@/lib/orders/logistics/template-params'
import { SendMessageError } from '@/lib/whatsapp/send-message'

describe('template params (mechanism only: no template is hardcoded)', () => {
  const order = { customer_name: 'Ana  Pérez', product_summary: '1 × A + 2 × B', quantity: 3, total: 20, destination: 'Lima\nCentro', seller_name: 'Vendedor', dni: null as string | null }

  it('fills the variables in the configured order and flattens what Meta rejects', () => {
    expect(buildTemplateBodyParams(order, ['customer_name', 'product', 'quantity', 'total', 'destination', 'seller_name'])).toEqual({
      ok: true,
      params: ['Ana Pérez', '1 × A + 2 × B', '3', '20.00', 'Lima Centro', 'Vendedor'],
    })
  })

  it('an empty DNI (or any empty value) never produces an empty parameter', () => {
    expect(buildTemplateBodyParams(order, ['dni'])).toEqual({ ok: true, params: [EMPTY_PARAM_FALLBACK] })
    expect(buildTemplateBodyParams({ ...order, dni: '   ' }, ['dni'])).toEqual({ ok: true, params: [EMPTY_PARAM_FALLBACK] })
    expect(buildTemplateBodyParams({ ...order, dni: '12345678' }, ['dni'])).toEqual({ ok: true, params: ['12345678'] })
  })

  it('an unknown field in the configuration is refused (never guessed)', () => {
    expect(buildTemplateBodyParams(order, ['customer_name', 'phone'])).toEqual({ ok: false, error: 'invalid_params_config' })
    expect(buildTemplateBodyParams(order, [3])).toEqual({ ok: false, error: 'invalid_params_config' })
  })

  it('sanitizeParam strips newlines, tabs and runs of spaces and caps the length', () => {
    expect(sanitizeParam(' a\n\tb   c ')).toBe('a b c')
    expect(sanitizeParam('x'.repeat(500))).toHaveLength(200)
  })
})

describe('classifySendError: `failed` = nothing reached WhatsApp, `uncertain` = it may have', () => {
  it('Meta answered with a rejection -> failed', () => {
    expect(classifySendError(new SendMessageError('meta_error', 'Meta API error: (#132000) number of parameters does not match', 502))).toEqual({ outcome: 'failed', code: 'meta_rejected' })
  })

  it.each(['fetch failed', 'The operation was aborted due to timeout', 'connect ECONNRESET', 'socket hang up'])('Meta unreachable (%s) -> uncertain: it may have been accepted', (message) => {
    expect(classifySendError(new SendMessageError('meta_error', `Meta API error: ${message}`, 502))).toEqual({ outcome: 'uncertain', code: 'meta_unreachable' })
  })

  it('sent to Meta but not saved -> uncertain (the message exists, the bookkeeping does not)', () => {
    expect(classifySendError(new SendMessageError('db_error', 'Message sent to Meta but failed to save to DB: boom', 500))).toEqual({ outcome: 'uncertain', code: 'persist_failed' })
  })

  it('refusals before any send (validation, blocked contact, no WhatsApp config, BSUID) -> failed with their own code', () => {
    expect(classifySendError(new SendMessageError('contact_blocked', 'blocked', 409))).toEqual({ outcome: 'failed', code: 'contact_blocked' })
    expect(classifySendError(new SendMessageError('whatsapp_not_configured', 'x', 400))).toEqual({ outcome: 'failed', code: 'whatsapp_not_configured' })
    expect(classifySendError(new SendMessageError('Weird-Code!', 'x', 400))).toEqual({ outcome: 'failed', code: 'weird_code_' })
  })

  it('anything unknown is uncertain (never assume nothing was sent)', () => {
    expect(classifySendError(new Error('boom'))).toEqual({ outcome: 'uncertain', code: 'send_unknown_error' })
    expect(classifySendError('x')).toEqual({ outcome: 'uncertain', code: 'send_unknown_error' })
  })
})

// ---- the service with fakes ----
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '99999999-9999-4999-8999-999999999999'
const ORDER = '22222222-2222-4222-8222-222222222222'
const DISPATCH = '88888888-8888-4888-8888-888888888888'
const CONV = '66666666-6666-4666-8666-666666666666'
const EVIDENCE = '44444444-4444-4444-8444-444444444444'

interface Scenario {
  settings?: Record<string, unknown> | null
  template?: Record<string, unknown> | null
  order?: Record<string, unknown> | null
  begin?: unknown
  beginError?: { code: string; message: string }
  evidence?: Record<string, unknown> | null
  signed?: 'ok' | 'error'
  mark?: unknown
  finish?: (outcome: string) => { data?: unknown; error?: { code: string; message: string } }
}
const SETTINGS = { packaging_template_name: 'tpl', packaging_template_language: 'es', packaging_template_params: ['customer_name', 'dni'] }
const TEMPLATE = { id: 'tpl-id', user_id: 'u-1', name: 'tpl', language: 'es', body_text: 'Hola {{1}} DNI {{2}}', header_type: 'image', status: 'APPROVED' }
const ORDER_ROW = { id: ORDER, confirmed_at: 't', customer_name: 'Ana', product: 'Prod', quantity: 1, price: '10.00', seller_name: 'S', order_status: 'x', delivery_status: 'held', agency: 'Shalom', destination: 'Lima', department: null, conversation_id: CONV, dni: null }

function fakes(s: Scenario) {
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const admin = {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        maybeSingle: async () => {
          if (table === 'order_logistics_settings') return { data: s.settings === undefined ? SETTINGS : s.settings, error: null }
          if (table === 'order_confirmations') return { data: s.order === undefined ? ORDER_ROW : s.order, error: null }
          if (table === 'order_documents') return { data: s.evidence === undefined ? { storage_path: 'account-x/orders/o/evidence/e/e.jpg', mime_type: 'image/jpeg' } : s.evidence, error: null }
          if (table === 'message_templates') return { data: null, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'message_templates' ? (s.template === undefined ? [TEMPLATE] : s.template ? [s.template] : []) : [], error: null }),
      }
      return b
    },
    storage: { from: () => ({ createSignedUrl: async () => (s.signed === 'error' ? { data: null, error: { message: 'x' } } : { data: { signedUrl: 'https://signed.example/h' }, error: null }) }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      if (name === 'begin_template_dispatch') return s.beginError ? { data: null, error: s.beginError } : { data: s.begin ?? { ok: true, replay: false, dispatch_id: DISPATCH, attempt: 1, evidence_document_id: EVIDENCE, conversation_id: CONV }, error: null }
      if (name === 'mark_template_dispatch_sending') return { data: s.mark ?? { ok: true }, error: null }
      if (name === 'finish_template_dispatch') {
        const r = s.finish ? s.finish(String(args.p_outcome)) : { data: { ok: true } }
        return { data: r.data ?? null, error: r.error ?? null }
      }
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
  const sendMessage = vi.fn()
  return { admin, rpcs, sendMessage }
}
const ctx = { supabase: {} as SupabaseClient, userId: USER, accountId: ACCOUNT }
const send = async (s: Scenario, key: unknown = 'k-1', sender?: (...a: never[]) => unknown) => {
  const f = fakes(s)
  if (sender) f.sendMessage.mockImplementation(sender as never)
  else f.sendMessage.mockResolvedValue({ messageId: 'msg-row-1', whatsappMessageId: 'wamid.1' })
  const r = await sendPackagingTemplate(ctx, f.admin, ORDER, key, { sendMessage: f.sendMessage })
  return { r, f, names: f.rpcs.map((x) => x.name) }
}

beforeEach(() => {
  assertAccess.mockReset()
  assertAccess.mockResolvedValue(undefined)
})

describe('sendPackagingTemplate · configuration refusals claim NOTHING', () => {
  it.each([
    ['no settings row', { settings: null }, 'template_not_configured'],
    ['template without name', { settings: { packaging_template_name: null, packaging_template_language: null, packaging_template_params: null } }, 'template_not_configured'],
    ['template not found in the account', { template: null }, 'template_not_found'],
    ['template not approved', { template: { ...TEMPLATE, status: 'PENDING' } }, 'template_not_approved'],
    ['video header', { template: { ...TEMPLATE, header_type: 'video' } }, 'template_header_unsupported'],
    ['text header with a variable', { template: { ...TEMPLATE, header_type: 'text', header_content: 'Hola {{1}}' } }, 'template_header_unsupported'],
    ['variables do not match the configured params', { settings: { ...SETTINGS, packaging_template_params: ['customer_name'] } }, 'template_params_mismatch'],
    ['an unknown param field', { settings: { ...SETTINGS, packaging_template_params: ['customer_name', 'phone'] } }, 'invalid_params_config'],
    ['order of another account', { order: null }, 'not_found'],
  ])('%s', async (_name, scenario, error) => {
    const { r, names, f } = await send(scenario as Scenario)
    expect(r).toMatchObject({ ok: false, status: expect.any(Number), error })
    expect(names).not.toContain('begin_template_dispatch')
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it('invalid ids / keys are 400', async () => {
    const f = fakes({})
    expect(await sendPackagingTemplate(ctx, f.admin, 'nope', 'k')).toMatchObject({ ok: false, status: 400, error: 'invalid_order_id' })
    expect(await sendPackagingTemplate(ctx, f.admin, ORDER, 'has space')).toMatchObject({ ok: false, status: 400, error: 'invalid_request_key' })
    expect(await sendPackagingTemplate(ctx, f.admin, ORDER, undefined)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('sendPackagingTemplate · the claim decides', () => {
  it.each([
    ['in_progress'],
    ['uncertain'],
    ['dispatch_open'],
    ['not_packing'],
    ['evidence_required'],
    ['already_ready'],
    ['order_without_conversation'],
  ])('database says %s -> 409 and NOTHING is sent', async (reason) => {
    const { r, f, names } = await send({ begin: { ok: false, reason, dispatch_id: DISPATCH } })
    expect(r).toMatchObject({ ok: false, status: 409, error: reason })
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(names).toEqual(['begin_template_dispatch'])
  })

  it('a replay of a completed operation answers `sent` without sending again', async () => {
    const { r, f } = await send({ begin: { ok: true, replay: true, status: 'sent', dispatch_id: DISPATCH } })
    expect(r).toMatchObject({ ok: true, status: 200, body: { status: 'sent', order_status: 'ready_for_dispatch', replay: true } })
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it('actor refused by the database -> 404; flag off -> 403', async () => {
    expect((await send({ beginError: { code: '42501', message: 'forbidden' } })).r).toMatchObject({ ok: false, status: 404 })
    expect((await send({ beginError: { code: '42501', message: 'feature_disabled' } })).r).toMatchObject({ ok: false, status: 403 })
  })
})

describe('sendPackagingTemplate · failures BEFORE Meta are `failed` (nothing was sent, same key can retry)', () => {
  it.each([
    ['evidence missing', { evidence: null }, 409, 'evidence_required'],
    ['evidence of the wrong type for an image header', { evidence: { storage_path: 'p', mime_type: 'application/pdf' } }, 409, 'evidence_type_mismatch'],
    ['the signed URL cannot be created', { signed: 'error' as const }, 502, 'storage_failed'],
  ])('%s', async (_name, scenario, status, code) => {
    const { r, f, names } = await send(scenario as Scenario)
    expect(r).toMatchObject({ ok: false, status, error: code, extra: { order_status: 'packing', status: 'failed' } })
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(names).toEqual(['begin_template_dispatch', 'finish_template_dispatch'])
    expect(f.rpcs[1].args).toMatchObject({ p_outcome: 'failed', p_error_code: code })
  })

  it('a conversation the caller may not work (routing stage) -> 403 failed, Meta never called', async () => {
    assertAccess.mockRejectedValue(new ForbiddenError('not available'))
    const { r, f, names } = await send({})
    expect(r).toMatchObject({ ok: false, status: 403, error: 'conversation_forbidden', extra: { status: 'failed' } })
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(names).toEqual(['begin_template_dispatch', 'finish_template_dispatch'])
  })

  it('a PDF evidence is fine for a document header; a template without media header does not need a signed URL', async () => {
    const doc = await send({ template: { ...TEMPLATE, header_type: 'document' }, evidence: { storage_path: 'p', mime_type: 'application/pdf' } })
    expect(doc.r.ok).toBe(true)
    const none = await send({ template: { ...TEMPLATE, header_type: undefined } })
    expect(none.r.ok).toBe(true)
    expect(none.f.sendMessage.mock.calls[0][2].templateMessageParams).toEqual({ body: ['Ana', EMPTY_PARAM_FALLBACK] })
  })
})

describe('sendPackagingTemplate · the send', () => {
  it('uses the EXISTING send core with the session actor, the order conversation and the resolved params; then completes the packaging', async () => {
    const { r, f, names } = await send({})
    expect(r).toMatchObject({ ok: true, status: 200, body: { status: 'sent', order_status: 'ready_for_dispatch', dispatch_id: DISPATCH, attempt: 1 } })
    expect(names).toEqual(['begin_template_dispatch', 'mark_template_dispatch_sending', 'finish_template_dispatch'])
    const [, accountId, params] = f.sendMessage.mock.calls[0]
    expect(accountId).toBe(ACCOUNT)
    expect(params).toMatchObject({
      conversationId: CONV,
      messageType: 'template',
      templateName: 'tpl',
      templateLanguage: 'es',
      templateParams: ['Ana', EMPTY_PARAM_FALLBACK],
      templateMessageParams: { body: ['Ana', EMPTY_PARAM_FALLBACK], headerMediaUrl: 'https://signed.example/h' },
      origin: 'manual_reply',
      actor: { userId: USER },
      senderId: USER,
    })
    expect(f.rpcs[2].args).toMatchObject({ p_outcome: 'sent', p_message_row_id: 'msg-row-1', p_wamid: 'wamid.1' })
    expect(assertAccess).toHaveBeenCalledWith(ctx.supabase, ACCOUNT, CONV)
  })

  it('Meta rejected the send -> `failed`: the order stays in packing, the answer says so', async () => {
    const { r, f } = await send({}, 'k', async () => {
      throw new SendMessageError('meta_error', 'Meta API error: (#132000) parameter mismatch', 502)
    })
    expect(r).toMatchObject({ ok: false, status: 502, error: 'send_failed', extra: { status: 'failed', error_code: 'meta_rejected', order_status: 'packing' } })
    expect(f.rpcs.at(-1)?.args).toMatchObject({ p_outcome: 'failed', p_error_code: 'meta_rejected' })
  })

  it('network failure / unsaved message / unknown crash -> `uncertain`, order stays in packing, never auto-resent', async () => {
    for (const error of [new SendMessageError('meta_error', 'Meta API error: fetch failed', 502), new SendMessageError('db_error', 'Message sent to Meta but failed to save to DB: x', 500), new Error('boom')]) {
      const { r, f } = await send({}, 'k', async () => {
        throw error
      })
      expect(r).toMatchObject({ ok: false, status: 409, error: 'send_uncertain', extra: { status: 'uncertain', order_status: 'packing' } })
      expect(f.rpcs.at(-1)?.args).toMatchObject({ p_outcome: 'uncertain' })
    }
  })

  it('the message was sent but recording it failed (twice): honest 500, the dispatch is NOT marked failed and the send is not repeated', async () => {
    const { r, f, names } = await send({ finish: () => ({ error: { code: 'XX000', message: 'db down' } }) })
    expect(r).toMatchObject({ ok: false, status: 500, error: 'dispatch_record_failed', extra: { status: 'sending' } })
    expect(f.sendMessage).toHaveBeenCalledTimes(1)
    expect(names.filter((n) => n === 'finish_template_dispatch')).toHaveLength(2) // one retry of the bookkeeping
    expect(f.rpcs.filter((x) => x.args.p_outcome === 'failed')).toHaveLength(0)
  })

  it('the claim was lost between claim and send (state changed) -> 409, nothing sent', async () => {
    const { r, f } = await send({ mark: { ok: false, reason: 'invalid_state', status: 'failed' } })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'in_progress' })
    expect(f.sendMessage).not.toHaveBeenCalled()
  })
})

describe('startPackaging / resolveDispatch', () => {
  const admin = (rpcData: unknown, found = true, rpcError?: { code: string; message: string }) =>
    ({
      from: () => {
        const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: found ? { id: DISPATCH } : null, error: null }) }
        return b
      },
      rpc: async () => ({ data: rpcData, error: rpcError ?? null }),
    }) as unknown as SupabaseClient

  it('start: ok / idempotent / refusals', async () => {
    expect(await startPackaging(ctx, admin({ ok: true, changed: true, status: 'packing' }), ORDER)).toMatchObject({ ok: true, body: { status: 'packing', changed: true } })
    expect(await startPackaging(ctx, admin({ ok: true, changed: false, status: 'packing' }), ORDER)).toMatchObject({ ok: true, body: { changed: false } })
    expect(await startPackaging(ctx, admin({ ok: false, reason: 'voucher_required' }), ORDER)).toMatchObject({ ok: false, status: 409, error: 'voucher_required' })
    expect(await startPackaging(ctx, admin(null, true, { code: '42501', message: 'forbidden' }), ORDER)).toMatchObject({ ok: false, status: 404 })
    expect(await startPackaging(ctx, admin({}), 'nope')).toMatchObject({ ok: false, status: 400 })
  })

  it('resolve: validates ids and the resolution, the dispatch must belong to the order; maps the result', async () => {
    expect(await resolveDispatch(ctx, admin({}), ORDER, { dispatchId: 'x', resolution: 'confirmed_sent' })).toMatchObject({ ok: false, status: 400, error: 'invalid_dispatch_id' })
    expect(await resolveDispatch(ctx, admin({}), ORDER, { dispatchId: DISPATCH, resolution: 'maybe' })).toMatchObject({ ok: false, status: 400, error: 'invalid_resolution' })
    expect(await resolveDispatch(ctx, admin({}, false), ORDER, { dispatchId: DISPATCH, resolution: 'confirmed_sent' })).toMatchObject({ ok: false, status: 404 })
    expect(await resolveDispatch(ctx, admin({ ok: true, changed: true, status: 'sent', order_status: 'ready_for_dispatch' }), ORDER, { dispatchId: DISPATCH, resolution: 'confirmed_sent' })).toMatchObject({
      ok: true,
      body: { status: 'sent', order_status: 'ready_for_dispatch', changed: true },
    })
    expect(await resolveDispatch(ctx, admin({ ok: false, reason: 'not_uncertain' }), ORDER, { dispatchId: DISPATCH, resolution: 'confirmed_sent' })).toMatchObject({ ok: false, status: 409, error: 'not_uncertain' })
  })
})
