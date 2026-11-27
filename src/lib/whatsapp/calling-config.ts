import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ForbiddenError } from '@/lib/auth/account'

export async function assertWhatsAppCallingEnabled(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  // Global gate is intentionally absent/false in all current environments.
  if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') {
    throw new ForbiddenError('WhatsApp Calling is disabled')
  }

  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('calling_enabled')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[calling-config] feature gate lookup failed', { code: error.code ?? 'unknown' })
    throw new Error('calling_feature_gate_unavailable')
  }
  if (data?.calling_enabled !== true) throw new ForbiddenError('WhatsApp Calling is disabled')
}

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
  await assertWhatsAppCallingEnabled(supabase, accountId)

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
