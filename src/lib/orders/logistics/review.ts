import type { SupabaseClient } from '@supabase/supabase-js'

import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import { compareWithOrder, type FieldComparison } from '@/lib/orders/logistics/compare'
import { DOCUMENT_PUBLIC_COLUMNS } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, readDocumentView, type DocumentView, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'

// Human review of a voucher: see the OCR data and its differences against the order, correct it, validate or reject it. The OCR never approves
// anything: `validate` is an explicit action of a logistics / supervisor person, recorded with who / when / what was corrected. Validated data is
// frozen by the database (a new version is a new document).

export const REVIEW_ACTIONS = ['correct', 'validate', 'reject'] as const
export type ReviewAction = (typeof REVIEW_ACTIONS)[number]

const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/
const MAX_FIELDS = 30
const MAX_VALUE_LENGTH = 200

/** reviewed_data is a flat object of short strings. Anything else is refused (never coerced silently). */
export function sanitizeReviewedData(input: unknown): Record<string, string> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!FIELD_NAME.test(key)) return null
    if (raw === null || raw === undefined) continue
    const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null
    if (value === null || value.length > MAX_VALUE_LENGTH) return null
    if (value !== '') out[key] = value
    if (Object.keys(out).length > MAX_FIELDS) return null
  }
  return out
}

const REASON_STATUS: Record<string, number> = {
  frozen: 409,
  stale: 409,
  association_required: 409,
  order_locked: 409,
  not_a_voucher: 400,
  reviewed_data_required: 422,
}

export interface ReviewInput {
  action: unknown
  expectedRowVersion?: unknown
  reviewedData?: unknown
}

export async function reviewDocument(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  documentId: string,
  input: ReviewInput,
): Promise<ServiceResult<{ document: DocumentView; changed: boolean; status: string; version: number | null }>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  if (typeof input.action !== 'string' || !(REVIEW_ACTIONS as readonly string[]).includes(input.action)) return fail(400, 'invalid_action')
  let expected: number | null = null
  if (input.expectedRowVersion !== undefined && input.expectedRowVersion !== null) {
    if (typeof input.expectedRowVersion !== 'number' || !Number.isInteger(input.expectedRowVersion) || input.expectedRowVersion < 1) return fail(400, 'invalid_row_version')
    expected = input.expectedRowVersion
  }
  let reviewed: Record<string, string> | null = null
  if (input.reviewedData !== undefined && input.reviewedData !== null) {
    reviewed = sanitizeReviewedData(input.reviewedData)
    if (reviewed === null) return fail(400, 'invalid_reviewed_data')
  }

  const { data, error } = await admin.rpc('review_order_document', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc: documentId,
    p_action: input.action,
    p_expected_row_version: expected,
    p_reviewed_data: reviewed,
  })
  if (error) return mapRpcError(error)

  const out = (data ?? {}) as { ok?: boolean; changed?: boolean; status?: string; version?: number; reason?: string; row_version?: number }
  if (out.ok !== true) return fail(REASON_STATUS[out.reason ?? ''] ?? 409, out.reason ?? 'rejected', out.row_version ? { row_version: out.row_version } : undefined)

  const document = await readDocumentView(admin, ctx.accountId, documentId)
  if (!document) return fail(500, 'internal_error')
  return { ok: true, status: 200, body: { document, changed: out.changed !== false, status: out.status ?? document.status, version: out.version ?? document.version } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Detail for the review screen
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface DocumentDetail {
  document: DocumentView & { ocr_provider: string | null; reviewed_at: string | null }
  /** The last normalized OCR result (suggestion), or null when no attempt succeeded. */
  ocr: { fields: Record<string, { value: string | null; confidence: number }>; model?: string } | null
  /** What a person corrected / accepted (never overwrites `ocr`). */
  reviewed_data: Record<string, string> | null
  /** OCR (or the reviewed data once it exists) against the order, as statuses. DNI / phone of the order are only ever masked. */
  comparison: FieldComparison[]
}

/** Read with the CALLER's client: RLS (flag + area + role + account) decides whether the document, its order and its data are visible at all. */
export async function getDocumentDetail(ctx: LogisticsCaller, documentId: string): Promise<ServiceResult<DocumentDetail>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  const { data: row, error } = await ctx.supabase
    .from('order_documents')
    .select(`${DOCUMENT_PUBLIC_COLUMNS}, ocr_provider, reviewed_at, ocr_result, reviewed_data`)
    .eq('account_id', ctx.accountId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) {
    console.error('[logistics] document detail failed:', error.code)
    return fail(500, 'internal_error')
  }
  if (!row) return fail(404, 'not_found')

  const { ocr_result: ocrResult, reviewed_data: reviewedData, ...document } = row as unknown as DocumentDetail['document'] & {
    ocr_result: DocumentDetail['ocr']
    reviewed_data: Record<string, string> | null
  }

  let comparison: FieldComparison[] = []
  if (document.order_id) {
    const { data: order } = await ctx.supabase
      .from('order_confirmations')
      .select('customer_name, dni, phone, price')
      .eq('account_id', ctx.accountId)
      .eq('id', document.order_id)
      .maybeSingle()
    if (order) {
      const current = reviewedData ? Object.fromEntries(Object.entries(reviewedData).map(([k, v]) => [k, { value: v }])) : (ocrResult?.fields ?? {})
      comparison = compareWithOrder(current, order as { customer_name: string; dni: string | null; phone: string; price: number | string })
    }
  }

  return { ok: true, status: 200, body: { document, ocr: ocrResult ?? null, reviewed_data: reviewedData ?? null, comparison } }
}
