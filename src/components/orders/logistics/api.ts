// Thin typed client of the PR-04 endpoints (browser side). It never sends an account, role or actor: the server derives all of that from the session.

export interface ApiResult<T> {
  ok: boolean
  status: number
  body: T & { error?: string }
}

export async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, { cache: 'no-store', ...init })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: { error: 'network_error' } as T & { error?: string } }
  }
}

export const postJson = <T = Record<string, unknown>>(path: string, payload: unknown) =>
  api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

/** Same operation = same key (a retry never duplicates); a new intent gets a new key. */
export const newRequestKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)

/** Broadcast "something changed on this order" so the list indicator refreshes without any state shared with the workspace. */
export const LOGISTICS_CHANGED_EVENT = 'wacrm:logistics-changed'
export const notifyLogisticsChanged = (orderId: string | null) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOGISTICS_CHANGED_EVENT, { detail: { orderId } }))
}

// ---- shapes returned by the API (mirror src/lib/orders/logistics/*) ----

export type LogisticsStatus = 'pending_voucher' | 'voucher_validated' | 'packing' | 'ready_for_dispatch'

export interface DocumentView {
  id: string
  order_id: string | null
  kind: 'voucher' | 'evidence'
  status: 'pending_review' | 'validated' | 'rejected' | 'superseded' | 'active'
  association: 'direct' | 'auto' | 'manual' | 'pending'
  version: number | null
  row_version: number
  batch_id: string | null
  original_filename: string
  mime_type: string
  size_bytes: number
  ocr_status: 'none' | 'pending' | 'done' | 'failed'
  ocr_attempts: number
  ocr_error_code: string | null
  validated_at: string | null
  created_at: string
}

export interface DispatchView {
  id: string
  status: 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain'
  attempt: number
  error_code: string | null
  resolution: string | null
  claimed_at: string
  finished_at: string | null
}

export interface OrderEventView {
  id: string
  event_type: string
  outcome: string
  attempt: number | null
  error_code: string | null
  actor_name: string
  created_at: string
}

export interface CustomerTemplateDispatchView {
  id: string
  kind: 'summary' | 'voucher'
  status: 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain'
  attempt: number
  error_code: string | null
  resolution: string | null
  voucher_document_id: string
  created_at: string
}

export interface PanelData {
  logistics: { status: LogisticsStatus; version: number; voucher_document_id?: string | null; evidence_document_id: string | null }
  vouchers: DocumentView[]
  evidence: DocumentView | null
  dispatches: DispatchView[]
  customer_dispatches: CustomerTemplateDispatchView[]
  events: OrderEventView[]
}

export interface FieldComparison {
  field: 'dni' | 'phone' | 'customer_name' | 'amount'
  status: 'match' | 'mismatch' | 'missing' | 'not_comparable'
  ocr_value: string | null
  order_value: string | null
}

export interface DocumentDetail {
  document: DocumentView & { ocr_provider: string | null }
  ocr: { fields: Record<string, { value: string | null; confidence: number }> } | null
  reviewed_data: Record<string, string> | null
  comparison: FieldComparison[]
}

export interface CandidateSummary {
  order_id: string
  customer_name: string
  product_summary: string
  total: number
  destination: string
  confirmed_at: string
  signals: string[]
}

export const ACCEPTED_FILES = 'application/pdf,image/jpeg,image/png,image/webp'
