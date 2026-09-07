/**
 * Multi-tenant resolution of the App Secret(s) to try when verifying
 * an inbound webhook's `x-hub-signature-256` (feat/per-account-meta-app-secret).
 *
 * `src/lib/whatsapp/webhook-signature.ts` knows how to check ONE
 * secret against a signature. This module's job is picking WHICH
 * secret(s) that is, for accounts that no longer all share the same
 * Meta App.
 *
 * PER-UNIT INTERSECTION (not a global union):
 *   One HTTP delivery can carry several `entry` objects — conceptually
 *   several independent "routing units" batched into one signed body.
 *   Accepting the request if ANY unit's secret matched would let a
 *   payload naming tenant A (signed with A's own secret) smuggle in an
 *   entry that actually belongs to tenant B — A's valid signature over
 *   the whole body says nothing about whether B's entry inside it is
 *   legitimate.
 *
 *   So instead: each routing unit gets its OWN allowed-secret set (see
 *   `extractWebhookSecretCandidateIds` for how a unit's routing key is
 *   picked), and this function returns the INTERSECTION across all of
 *   them. Only a secret that is valid for EVERY unit in the payload —
 *   i.e. one Meta App's worth of trust actually covers the whole
 *   delivery — is returned. If any unit resolves to zero secrets (no
 *   config identifiable for it) or the intersection across units is
 *   empty, the result is `[]` and the caller must reject the request,
 *   never fall back to accepting on a partial match.
 *
 * Per-unit secret resolution:
 *   - phone_number_id unit: the exact `whatsapp_config` row's own
 *     `app_secret` if it has one, otherwise the legacy global
 *     `process.env.META_APP_SECRET` (and ONLY for that row/unit).
 *   - waba_id unit (only entries with no phone_number_id at all): the
 *     union of secrets from every config sharing that WABA — several
 *     phone numbers can be valid candidates for a WABA-level event.
 *
 * PRECEDENCE — phone_number_id beats waba_id, per entry:
 *   An entry that already names an exact `phone_number_id` becomes a
 *   phone_number_id-keyed unit; its `waba_id` is never ALSO turned
 *   into a separate unit for that entry. `entry.id` (the WABA id) is
 *   used as a unit's routing key only for an entry that carries no
 *   `phone_number_id` anywhere in its changes (e.g. a template-
 *   lifecycle event, which is WABA-level by nature) — see
 *   `extractWebhookSecretCandidateIds`.
 *
 * SECURITY NOTE — the body passed in here has NOT been signature-
 * verified yet. Every function below treats it as untrusted: it is
 * read defensively (no assumptions about shape) and used ONLY to
 * pick which row(s) to query and which secret(s) to try. Nothing here
 * writes to the database, dispatches an event, or otherwise produces
 * a business effect — see the webhook route for where the line is.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

export interface WebhookSecretCandidateIds {
  /** `change.value.metadata.phone_number_id` — exact-match candidates. */
  phoneNumberIds: string[]
  /**
   * `entry.id` (the WABA id, per Meta's webhook envelope) — FALLBACK
   * candidates only. Populated exclusively from entries whose changes
   * carried no `phone_number_id` at all; an entry that already names
   * an exact number never contributes its `waba_id` here, precisely so
   * a sibling `whatsapp_config` row on the same WABA can't smuggle in
   * the legacy global-secret fallback for a request that's already
   * exactly identified.
   */
  wabaIds: string[]
}

/**
 * Pull the routing ids out of an untrusted, not-yet-verified webhook
 * body. Every access is defensive — a malformed or adversarial payload
 * (wrong types, missing fields, deeply nested garbage) yields empty
 * arrays rather than throwing, so a hostile POST can't crash the route
 * before signature verification even runs.
 *
 * Precedence is per ENTRY: if any change inside an entry names a
 * `phone_number_id`, that entry contributes ONLY phone_number_id
 * candidates — its `waba_id` is deliberately dropped, even if other
 * changes in the same entry lack one. `waba_id` is collected as a
 * candidate only for an entry with NO `phone_number_id` anywhere in
 * it (e.g. a template-lifecycle event, which is WABA-level by nature).
 * See the module doc comment for why this precedence matters.
 */
export function extractWebhookSecretCandidateIds(
  body: unknown,
): WebhookSecretCandidateIds {
  const phoneNumberIds = new Set<string>()
  const wabaIds = new Set<string>()

  const entries = (body as { entry?: unknown } | null)?.entry
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const wabaId = (entry as { id?: unknown } | null)?.id
      const changes = (entry as { changes?: unknown } | null)?.changes

      const entryPhoneNumberIds: string[] = []
      if (Array.isArray(changes)) {
        for (const change of changes) {
          const phoneNumberId = (
            change as { value?: { metadata?: { phone_number_id?: unknown } } } | null
          )?.value?.metadata?.phone_number_id
          if (typeof phoneNumberId === 'string' && phoneNumberId) {
            entryPhoneNumberIds.push(phoneNumberId)
          }
        }
      }

      if (entryPhoneNumberIds.length > 0) {
        for (const id of entryPhoneNumberIds) phoneNumberIds.add(id)
      } else if (typeof wabaId === 'string' && wabaId) {
        wabaIds.add(wabaId)
      }
    }
  }

  return {
    phoneNumberIds: [...phoneNumberIds],
    wabaIds: [...wabaIds],
  }
}

interface CandidateConfigRow {
  id: string
  account_id: string
  phone_number_id: string
  waba_id: string | null
  app_secret: string | null
}

/**
 * Resolve the list of secrets worth trying against this request's
 * signature — the INTERSECTION of every routing unit's own allowed-
 * secret set (see the module doc comment). Queries are parameterized
 * via `.in()` (never string-interpolated into a `.or()` filter) so an
 * adversarial phone_number_id or waba_id containing PostgREST filter
 * syntax (commas, parentheses) can't manipulate the query — every
 * candidate id is still untrusted input at this point.
 *
 * Returns an EMPTY array when:
 *   - the payload has no extractable routing ids at all, or
 *   - any single routing unit resolves to zero secrets (its
 *     phone_number_id or waba_id matches no `whatsapp_config` row), or
 *   - the units' secret sets have no secret in common.
 * In every case the caller must treat `[]` as "reject" — never fall
 * back to accepting on the strength of a partial match.
 */
export async function resolveWebhookSignatureSecrets(
  supabase: SupabaseClient,
  body: unknown,
): Promise<string[]> {
  const { phoneNumberIds, wabaIds } = extractWebhookSecretCandidateIds(body)
  if (phoneNumberIds.length === 0 && wabaIds.length === 0) return []

  const columns = 'id, account_id, phone_number_id, waba_id, app_secret'

  const rowsByPhoneNumberId = new Map<string, CandidateConfigRow[]>()
  if (phoneNumberIds.length > 0) {
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select(columns)
      .in('phone_number_id', phoneNumberIds)
    if (error) {
      console.error('[webhook] config lookup by phone_number_id failed:', error.message)
    } else {
      for (const row of (data ?? []) as CandidateConfigRow[]) {
        const bucket = rowsByPhoneNumberId.get(row.phone_number_id) ?? []
        bucket.push(row)
        rowsByPhoneNumberId.set(row.phone_number_id, bucket)
      }
    }
  }

  const rowsByWabaId = new Map<string, CandidateConfigRow[]>()
  if (wabaIds.length > 0) {
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select(columns)
      .in('waba_id', wabaIds)
    if (error) {
      console.error('[webhook] config lookup by waba_id failed:', error.message)
    } else {
      for (const row of (data ?? []) as CandidateConfigRow[]) {
        if (!row.waba_id) continue
        const bucket = rowsByWabaId.get(row.waba_id) ?? []
        bucket.push(row)
        rowsByWabaId.set(row.waba_id, bucket)
      }
    }
  }

  // One routing unit per exact phone_number_id, plus one per WABA-only
  // entry. A unit with no matching rows yields an empty set, which
  // collapses the overall intersection to empty — exactly the
  // fail-closed behavior we want for "this unit names a tenant we
  // can't identify."
  const unitSecretSets: Set<string>[] = [
    ...phoneNumberIds.map((id) => secretsForConfigRows(rowsByPhoneNumberId.get(id) ?? [])),
    ...wabaIds.map((id) => secretsForConfigRows(rowsByWabaId.get(id) ?? [])),
  ]

  return [...intersectSecretSets(unitSecretSets)]
}

/**
 * Per-row secret resolution: a row's OWN `app_secret` if it has one,
 * otherwise the legacy global fallback for that row alone. Shared by
 * both phone_number_id-keyed and waba_id-keyed units.
 */
function secretsForConfigRows(rows: CandidateConfigRow[]): Set<string> {
  const secrets = new Set<string>()
  for (const row of rows) {
    if (row.app_secret) {
      try {
        secrets.add(decrypt(row.app_secret))
      } catch {
        // Corrupted ciphertext or a stale ENCRYPTION_KEY — never log the
        // value itself. Skip this candidate rather than throwing; other
        // candidates (a different config on the same WABA, or another
        // matched row) may still verify.
        console.error(
          '[webhook] app_secret decryption failed for whatsapp_config',
          row.id,
          '— skipping this candidate',
        )
      }
    } else {
      // This specific row has no app_secret configured yet — legacy
      // fallback applies to IT, not as a blanket rule for the request.
      const fallback = process.env.META_APP_SECRET
      if (fallback) secrets.add(fallback)
    }
  }
  return secrets
}

/**
 * Intersect every routing unit's secret set. An empty input (no units
 * at all) returns an empty set — callers only reach this with at least
 * one unit, since `resolveWebhookSignatureSecrets` early-returns `[]`
 * before this point when there's nothing to intersect.
 */
function intersectSecretSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set()
  let result = sets[0]
  for (let i = 1; i < sets.length && result.size > 0; i++) {
    result = new Set([...result].filter((secret) => sets[i].has(secret)))
  }
  return result
}
