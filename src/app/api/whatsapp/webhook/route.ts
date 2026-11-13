import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { resolveWebhookSignatureSecrets } from '@/lib/whatsapp/webhook-tenant-secret'
import { enqueueVerifiedWebhook, drainWebhookInbox } from '@/lib/whatsapp/webhook-inbox'
import { processWebhook, type MetaWebhookPayload } from '@/lib/whatsapp/webhook-processor'

export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return _adminClient
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  // Refuse oversized payloads without persisting unbounded customer PII.
  if (Buffer.byteLength(rawBody, 'utf8') > 1024 * 1024) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const signature = request.headers.get('x-hub-signature-256')

  // Multi-tenant signature verification (feat/per-account-meta-app-secret):
  // different accounts can be behind different Meta Apps, each with its
  // own App Secret, so a single global process.env.META_APP_SECRET can no
  // longer be the sole source of truth. We need to know WHICH account's
  // whatsapp_config this payload claims to be from before we know which
  // secret to check the signature against.
  //
  // Parsing here is safe: this JSON is used ONLY to extract routing ids
  // (phone_number_id / waba_id) for that lookup — see
  // webhook-tenant-secret.ts's file-level doc comment. It is NOT used for
  // any business logic (no DB writes, no dispatch) until AFTER the
  // signature check below passes. A parse failure is treated the same as
  // "no config identifiable": fail closed.
  let body: MetaWebhookPayload
  try {
    body = JSON.parse(rawBody)
  } catch {
    console.warn('[webhook] rejected request with unparseable body')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const candidateSecrets = await resolveWebhookSignatureSecrets(supabaseAdmin(), body)
  if (candidateSecrets.length === 0) {
    // No whatsapp_config row could be identified from this payload at
    // all — never fall back to accepting on the strength of the global
    // secret alone (that would let a spoofed phone_number_id/waba_id
    // borrow ANY tenant's trust). Fail closed.
    console.warn('[webhook] rejected request — no whatsapp_config resolvable for signature verification')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Accept if the signature matches ANY resolved candidate. A specific
  // config's own app_secret and the legacy global fallback are never
  // both in this list for the SAME config — see resolveWebhookSignatureSecrets
  // — so a tenant with its own app_secret can never be satisfied by the
  // global secret, and vice versa.
  const verified = candidateSecrets.some((secret) =>
    verifyMetaWebhookSignature(rawBody, signature, secret),
  )
  if (!verified) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Acknowledge Meta only AFTER the verified delivery has a durable row.
  // An outage in PostgREST/DB returns 503 so Meta can retry, rather than
  // returning 200 and losing the message in an unobserved after() failure.
  let eventId: string
  try {
    eventId = await enqueueVerifiedWebhook(supabaseAdmin(), rawBody, body)
  } catch {
    return NextResponse.json(
      { error: 'Webhook temporarily unavailable' },
      { status: 503, headers: { 'Retry-After': '5' } },
    )
  }

  // Low-latency best effort; the authenticated cron independently drains
  // any event left behind by a process crash, DB outage or expired lease.
  // Both paths use an atomic claim so they cannot process the same event
  // concurrently while its lease is valid.
  after(async () => {
    try {
      await drainWebhookInbox(
        supabaseAdmin(),
        (payload) => processWebhook(payload as MetaWebhookPayload),
        { eventId },
      )
    } catch {
      console.error('[webhook-inbox] immediate drain unavailable; cron will retry')
    }
  })

  return NextResponse.json({ status: 'queued' }, { status: 200 })
}
