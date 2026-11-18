// Test support for PR-05 (real local stack only, see logistics/test-support/qa-env): an order that PR-04 left in `ready_for_dispatch`.
// The PR-04 rows are inserted directly with the service role (valid per the PR-04 constraints) instead of replaying the whole voucher / OCR / packaging
// flow, which PR-04's own suites already cover.
import { randomBytes, randomUUID } from 'node:crypto'

import type { QaWorld } from '@/lib/orders/logistics/test-support/qa-env'

const hex = () => randomBytes(32).toString('hex')

export async function mkReadyOrder(w: QaWorld, accountId: string, key: string, fields: Record<string, unknown> = {}): Promise<string> {
  const order = await w.mkOrder(accountId, key, fields)
  const actor = accountId === w.acc ? w.logi.id : w.foreign.id
  const now = new Date().toISOString()
  const mkDoc = async (kind: 'voucher' | 'evidence') => {
    const id = randomUUID()
    const base = {
      id,
      account_id: accountId,
      order_id: order,
      kind,
      association: 'direct',
      request_key: `${w.tag}-${key}-${kind}-${randomBytes(3).toString('hex')}`,
      storage_path: `account-${accountId}/orders/${order}/${kind}s/${id}/f.pdf`,
      original_filename: 'f.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10,
      content_hash: hex(),
      uploaded_by: actor,
    }
    const row =
      kind === 'voucher'
        ? { ...base, status: 'validated', source: 'upload', version: 1, reviewed_data: { dni: '12345678' }, validated_by: actor, validated_at: now }
        : { ...base, status: 'active', source: 'upload' }
    const { error } = await w.admin.from('order_documents').insert(row)
    if (error) throw error
    return id
  }
  const voucher = await mkDoc('voucher')
  const evidence = await mkDoc('evidence')
  const dispatch = randomUUID()
  // PR-04's guards force the real state machine: claimed -> sending -> sent
  const d = await w.admin.from('order_template_dispatches').insert({
    id: dispatch, account_id: accountId, order_id: order, request_key: `${w.tag}-${key}-d`, status: 'claimed', evidence_document_id: evidence,
    template_name: 't', template_language: 'es', actor_user_id: actor,
  })
  if (d.error) throw d.error
  const d2 = await w.admin.from('order_template_dispatches').update({ status: 'sending', sending_at: now }).eq('id', dispatch)
  if (d2.error) throw d2.error
  const d3 = await w.admin.from('order_template_dispatches').update({ status: 'sent', wamid: `wamid.${randomBytes(6).toString('hex')}`, finished_at: now }).eq('id', dispatch)
  if (d3.error) throw d3.error
  const l = await w.admin.from('order_logistics').insert({
    order_id: order, account_id: accountId, status: 'ready_for_dispatch', voucher_document_id: voucher, validated_at: now, validated_by: actor, evidence_document_id: evidence,
    packaging_started_at: now, packaging_started_by: actor, packaging_completed_at: now, packaging_completed_by: actor, completed_dispatch_id: dispatch,
  })
  if (l.error) throw l.error
  return order
}

export async function setShipmentFlag(w: QaWorld, accountId: string, enabled: boolean): Promise<void> {
  const { error } = await w.admin.from('order_shipment_settings').upsert({ account_id: accountId, shalom_tracking_enabled: enabled })
  if (error) throw error
}
