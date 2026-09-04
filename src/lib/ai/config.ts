import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider, EmbeddingsProvider } from './types'

/**
 * Which embeddings provider an account's `embeddings_api_key` belongs
 * to — derived, never stored. Gemini chat accounts use Gemini
 * embeddings; OpenAI and Anthropic chat accounts use OpenAI embeddings
 * (Anthropic has no embeddings endpoint). Null with no key at all —
 * the caller never has to guess a provider from the key's shape.
 *
 * Only inspects whether `embeddingsApiKey` is present, never its
 * content — so a caller that only needs a presence signal (e.g. the
 * config route diffing old vs. new to decide whether to clear stale
 * vectors) can pass the still-encrypted ciphertext here instead of
 * decrypting it first.
 */
export function deriveEmbeddingsProvider(
  chatProvider: AiProvider,
  embeddingsApiKey: string | null,
): EmbeddingsProvider | null {
  if (!embeddingsApiKey) return null
  return chatProvider === 'gemini' ? 'gemini' : 'openai'
}

interface AiConfigRow {
  provider: AiProvider
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    embeddingsProvider: deriveEmbeddingsProvider(row.provider, embeddingsApiKey),
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt, provider }`: `key` is null when there's no
 * key OR it can't be decrypted; `corrupt` distinguishes those cases so
 * callers can warn ("a key is set but unusable") rather than silently
 * indexing lexical-only and reporting success; `provider` is the
 * embeddings provider to embed with (derived from the account's chat
 * `provider` the same way `loadAiConfig` does — see
 * `deriveEmbeddingsProvider`), null whenever `key` is null.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean; provider: EmbeddingsProvider | null }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('provider, embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false, provider: null }
  try {
    const key = decrypt(data.embeddings_api_key)
    return { key, corrupt: false, provider: deriveEmbeddingsProvider(data.provider, key) }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true, provider: null }
  }
}
