import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeAdReferral } from './ad-referral'

/**
 * Additive click history for Meta conversions: contact_ad_attributions keeps only the FIRST attribution (unchanged), this stores every click that carried
 * a ctwa_clid so a later order can be tied to the click that really preceded it. Idempotent per (contact, ctwa_clid). Best effort: never throws, never
 * logs the payload.
 */
export async function recordAdClick(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; referral: unknown },
): Promise<'stored' | 'ignored' | 'error'> {
  const ad = normalizeAdReferral(args.referral)
  if (!ad || !ad.ctwa_clid) return 'ignored'
  try {
    const { error } = await db.from('contact_ad_clicks').upsert(
      {
        account_id: args.accountId,
        contact_id: args.contactId,
        ctwa_clid: ad.ctwa_clid,
        source_id: ad.source_id,
        source_url: ad.source_url,
        headline: ad.headline,
      },
      { onConflict: 'account_id,contact_id,ctwa_clid', ignoreDuplicates: true },
    )
    if (error) {
      console.error('[webhook] ad click history not stored:', error.code ?? 'error')
      return 'error'
    }
    return 'stored'
  } catch {
    console.error('[webhook] ad click history not stored: exception')
    return 'error'
  }
}
