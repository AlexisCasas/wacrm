/**
 * TEMPORARY diagnostic: describe the SHAPE of a webhook change (field names, value types, presence), never its values.
 *
 * Purpose: confirm, with a real event from the account under test, which identity fields Meta sends for a user without a
 * visible number. Off by default. It runs only while BOTH variables are set:
 *   WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS  comma-separated business phone_number_id values (the account under test)
 *   WEBHOOK_SHAPE_LOG_UNTIL             ISO timestamp; after it the logger is inert even if the first variable stays set
 * It prints key paths and primitive types, arrays as `[n]`, and for the identity fields only whether they are present and
 * whether their value has the expected shape (`bsuid-shaped`, `parent-bsuid-shaped`, `digits`, `other`). It never prints a
 * phone number, an id, a username, a name, message text or a token.
 * Retire it by unsetting both variables (it then does nothing) and deleting this file and its single call in the webhook route.
 */
import { isValidBsuid, isValidParentBsuid } from './bsuid'

const IDENTITY_KEYS = new Set(['from', 'wa_id', 'from_user_id', 'user_id', 'parent_user_id', 'from_parent_user_id', 'recipient_id', 'recipient_user_id', 'previous_user_id'])

function classify(value: unknown): string {
  if (typeof value !== 'string') return typeof value
  if (isValidParentBsuid(value)) return 'parent-bsuid-shaped'
  if (isValidBsuid(value)) return 'bsuid-shaped'
  if (/^\d{6,20}$/.test(value)) return 'digits'
  return 'other'
}

export function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? '[0]' : { [`[${value.length}]`]: describeShape(value[0], depth + 1) }
  if (typeof value !== 'object') return typeof value
  if (depth > 6) return 'object'
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = IDENTITY_KEYS.has(key) ? classify(v) : describeShape(v, depth + 1)
  }
  return out
}

export function shapeLoggingActiveFor(phoneNumberId: string | undefined, now = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
  const until = Date.parse(env.WEBHOOK_SHAPE_LOG_UNTIL ?? '')
  if (!phoneNumberId || !Number.isFinite(until) || now > until) return false
  return (env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(phoneNumberId)
}
