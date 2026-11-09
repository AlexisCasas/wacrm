import type { SupabaseClient } from '@supabase/supabase-js'

/** Meta sends failures in statuses[].errors. Never persist raw message/error_data:
 * they can contain phone numbers and free-form personal data. */
export interface DeliveryFailureReason {
  code: number
  title: string | null
}

export function normalizeMetaDeliveryFailure(errors: unknown): DeliveryFailureReason | null {
  if (!Array.isArray(errors)) return null
  for (const item of errors) {
    if (!item || typeof item !== 'object') continue
    const e = item as { code?: unknown; title?: unknown }
    if (typeof e.code !== 'number' || !Number.isSafeInteger(e.code) || e.code < 1 || e.code > 999999) continue
    const title = typeof e.title === 'string'
      ? e.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
      : ''
    return { code: e.code, title: title || null }
  }
  return null
}

/** Best effort: a failure in observability must not interrupt STATUS handling. The
 * database RPC is account-scoped, requires service_role, and only touches outbound
 * messages already marked failed. Replays can fill missing reasons but cannot replace
 * an existing reason or make the delivery status regress. */
export async function recordMetaDeliveryFailure(
  db: SupabaseClient,
  args: { accountId: string; wamid: string; errors: unknown },
): Promise<'ignored' | 'stored' | 'error'> {
  const reason = normalizeMetaDeliveryFailure(args.errors)
  if (!reason) return 'ignored'
  try {
    const { error } = await db.rpc('record_whatsapp_delivery_failure', {
      p_account_id: args.accountId,
      p_wamid: args.wamid,
      p_code: reason.code,
      p_title: reason.title,
    })
    if (error) {
      console.error('[webhook] storing delivery failure reason failed', { code: error.code ?? 'db_error' })
      return 'error'
    }
    return 'stored'
  } catch {
    console.error('[webhook] storing delivery failure reason exception')
    return 'error'
  }
}
