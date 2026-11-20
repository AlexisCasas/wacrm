import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

export interface WhatsAppCallingConfig {
  phoneNumberId: string
  wabaId: string | null
  accessToken: string
  messagingAccountId: string | null
}

/**
 * Resolve the connected WhatsApp number from the authenticated account's
 * own RLS-scoped configuration. Never accept phone_number_id or tokens from
 * a browser request as authority.
 */
export async function getWhatsAppCallingConfig(
  supabase: SupabaseClient,
  accountId: string,
): Promise<WhatsAppCallingConfig> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, waba_id, access_token, messaging_account_id, status')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[calling-config] account config lookup failed', { code: error.code ?? 'unknown' })
    throw new Error('calling_config_lookup_failed')
  }
  if (!data || data.status !== 'connected' || !data.access_token || !data.phone_number_id) {
    throw new Error('whatsapp_number_not_connected')
  }

  let accessToken: string
  try {
    accessToken = decrypt(data.access_token)
  } catch {
    console.error('[calling-config] stored access token could not be decrypted')
    throw new Error('calling_config_token_unavailable')
  }

  return {
    phoneNumberId: data.phone_number_id,
    wabaId: data.waba_id ?? null,
    accessToken,
    messagingAccountId: data.messaging_account_id ?? null,
  }
}
