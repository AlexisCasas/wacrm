import type { SupabaseClient } from '@supabase/supabase-js'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConversationRow = any

export interface ConversationOutcome {
  conversation: ConversationRow
  created: boolean
}

/**
 * Find-or-create the (account, contact) conversation. Shared by every
 * inbound path that mirrors a customer message into the CRM (the Meta
 * webhook, and the ManyChat bridge — see
 * src/app/api/integrations/manychat/inbound/route.ts).
 *
 * Extracted verbatim from the Meta webhook's private helper — behavior
 * is unchanged, confirmed by the webhook's existing test suite passing
 * after the extraction.
 */
export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
): Promise<ConversationOutcome | null> {
  // Oldest-first, one row. `.single()` is deliberately avoided — it
  // errors on both 0 rows and ≥2 rows, which used to make a duplicate
  // pair snowball into a wall of duplicate chats (issue #363). Ordering
  // oldest-first resolves to the same canonical survivor the dedup
  // migration (036) keeps.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Same tenancy + audit split as findOrCreateContact.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
