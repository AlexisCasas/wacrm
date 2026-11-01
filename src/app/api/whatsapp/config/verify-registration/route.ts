import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  getTokenAppId,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { isRegistrationLive, registrationSource } from '@/lib/whatsapp/registration-state'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means WACRM never
 *                    registered it. A number registered in Meta BEFORE
 *                    WACRM (e.g. by a previous provider) is reported as
 *                    registration_source 'meta_prior' and counts as live
 *                    only if Meta confirms CONNECTED, the app is subscribed
 *                    and the account is activated. registered_at is never
 *                    invented for it.
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    /** The app of this account's token could be identified (accounts may each use their own App ID). false => the subscription cannot be confirmed. */
    app_identity_verified: boolean | null
    locally_marked_registered: boolean
    meta_confirms_connected: boolean | null
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    app_identity_verified: null,
    locally_marked_registered: config.registered_at != null,
    meta_confirms_connected: null,
  }
  let metaPhoneStatus: string | undefined
  const errors: string[] = []

  // 1. Phone metadata
  try {
    const phone = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
    metaPhoneStatus = phone?.status
    checks.meta_confirms_connected = phone?.status === 'CONNECTED'
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // A non-empty list does NOT mean OUR app is in it: a WABA can have another provider's app subscribed (e.g. ManyChat) and not ours.
      // Identify the app of THIS account's token (accounts may use different App IDs) and require that exact app among the subscribers.
      let appId: string | null = null
      try {
        appId = await getTokenAppId({ accessToken })
      } catch {
        appId = null // getTokenAppId does not throw; this keeps an unexpected failure from ever reading as a PASS
      }
      checks.app_identity_verified = appId != null
      if (appId == null) {
        // Never a false PASS: if we cannot tell which app this token is, we cannot say it is subscribed.
        checks.waba_subscribed_to_app = null
        errors.push(
          'Could not identify this account\'s Meta app from its token, so the app subscription cannot be confirmed.',
        )
      } else {
        checks.waba_subscribed_to_app = subs.some(
          (s) => s.whatsapp_business_api_data?.id === appId,
        )
        if (!checks.waba_subscribed_to_app) {
          errors.push(
            subs.length === 0
              ? 'WABA has no subscribed apps. Re-save the configuration to subscribe.'
              : 'Other apps are subscribed to this WABA, but this account\'s app is not. Re-save the configuration to subscribe it.',
          )
        }
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
    )
  }

  const source = registrationSource({
    registeredAt: config.registered_at,
    status: config.status,
    subscribedAppsAt: config.subscribed_apps_at,
    metaPhoneStatus,
  })
  const live = isRegistrationLive({
    phoneMetadataOk: checks.phone_metadata_ok,
    wabaSubscribed: checks.waba_subscribed_to_app,
    source,
  })

  return NextResponse.json({
    live,
    // 'wacrm' = registered by WACRM (registered_at is its real time); 'meta_prior' = already registered in Meta, confirmed now; 'none'.
    registration_source: source,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
