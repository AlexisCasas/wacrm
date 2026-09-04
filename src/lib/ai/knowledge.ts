import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search — with a keyword-decomposition fallback for
// when the strict full-text query finds nothing).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

type EmbeddingsConfig = Pick<AiConfig, 'embeddingsApiKey' | 'embeddingsProvider'>

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk with the configured provider
 * (`config.embeddingsProvider` — OpenAI or Gemini). Runs under whatever
 * client the caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingsConfig,
  documentId: string,
  title: string | null,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  //
  // `title` only affects what gets SENT to Gemini for embedding
  // (`title: {title} | text: {chunk}` — Google's recommended asymmetric
  // document format for gemini-embedding-2); the persisted
  // `content` below is always the raw, unprefixed chunk. OpenAI ignores
  // `title` entirely — it embeds the chunk text as-is.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey && config.embeddingsProvider) {
    try {
      embeddings = await embedTexts(config.embeddingsProvider, config.embeddingsApiKey, chunks, {
        kind: 'document',
        title,
      })
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

// ------------------------------------------------------------
// Lexical keyword fallback.
//
// `match_ai_knowledge_fts` runs `plainto_tsquery('simple', p_query)`,
// which ANDs every token in the query — so a full natural-language
// question ("Hola, ¿qué productos venden?") requires "hola" AND "que"
// AND "productos" AND "venden" to ALL appear in the same chunk, which
// almost never happens even when the chunk plainly answers the
// question (it has "productos" but not "hola"/"que"/"venden"). When
// that strict search returns nothing, decompose the query into
// individual keywords and search each one — each is itself a valid
// (single-token) plainto_tsquery, so this reuses the exact same
// RPC/index, just OR'd across terms in the application layer instead
// of AND'd inside Postgres.
// ------------------------------------------------------------

const MIN_KEYWORD_LENGTH = 3
const MAX_FALLBACK_KEYWORDS = 6

// Common closed-class words (articles, prepositions, pronouns,
// conjunctions, auxiliary verbs) in Spanish and English — genuinely
// stop words, not domain terms. Content verbs like "venden"/"tienen"
// are deliberately NOT included: excluding them isn't linguistically
// justified, and leaving them in is harmless (a per-term FTS search for
// "tienen" just returns 0 rows and is ignored).
const STOPWORDS = new Set([
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'u', 'pero', 'si',
  'de', 'del', 'al', 'en', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'hacia',
  'hasta', 'desde', 'durante', 'antes', 'después', 'muy', 'más', 'menos', 'tan',
  'tanto', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'su', 'sus',
  'mi', 'mis', 'tu', 'tus', 'nos', 'les', 'le', 'lo', 'se', 'me', 'te', 'nosotros',
  'ustedes', 'yo', 'usted', 'ser', 'estar', 'hay', 'que', 'qué', 'como', 'cómo',
  'donde', 'dónde', 'cuando', 'cuándo', 'cual', 'cuál', 'quien', 'quién', 'porque',
  'hola', 'buenas', 'buenos', 'gracias', 'favor', 'the',
  // English
  'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'have', 'has', 'had',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now',
  'what', 'which', 'who', 'whom', 'be', 'been', 'being', 'hi', 'hello', 'please',
  'thanks',
])

/**
 * Extract candidate keywords from a natural-language question for the
 * per-term lexical fallback. Unicode-aware tokenization (accented
 * words like "ubicación" survive intact), lowercased, punctuation
 * stripped, very short tokens and stopwords removed, deduplicated, and
 * capped so a verbose question can't fan out into dozens of RPC calls.
 */
export function extractKeywords(query: string): string[] {
  const tokens = query.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const token of tokens) {
    if (token.length < MIN_KEYWORD_LENGTH) continue
    if (STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    keywords.push(token)
    if (keywords.length >= MAX_FALLBACK_KEYWORDS) break
  }
  return keywords
}

/**
 * Run the strict full-text RPC for each keyword in parallel and merge
 * the results into `picked` (id → content, dedup'd, capped at `k`).
 * Best-effort: an individual RPC failure/rejection is skipped rather
 * than aborting the other keywords' results.
 */
async function fillFromKeywordFallback(
  db: SupabaseClient,
  accountId: string,
  query: string,
  k: number,
  picked: Map<string, string>,
): Promise<void> {
  const keywords = extractKeywords(query)
  if (keywords.length === 0) return

  const settled = await Promise.allSettled(
    keywords.map((term) =>
      db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: term,
        p_match_count: k,
      }),
    ),
  )

  for (const result of settled) {
    if (picked.size >= k) break
    if (result.status !== 'fulfilled') continue
    const { data, error } = result.value
    if (error || !Array.isArray(data)) continue
    for (const row of data as MatchRow[]) {
      if (picked.size >= k) break
      if (!picked.has(row.id)) picked.set(row.id, row.content)
    }
  }
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query with the account's provider → cosine-nearest chunks), then
 * topped up with lexical full-text matches to fill `k`. The lexical
 * step tries the strict whole-query search FIRST; only when that finds
 * literally nothing does it fall back to searching the query's
 * individual keywords (see `fillFromKeywordFallback`) — a natural-
 * language question ("¿Tienen taladros?") otherwise ANDs every token
 * and matches nothing even when "taladros" plainly appears in the KB.
 * Lexical-only (strict, then keyword fallback) when there's no
 * embeddings key. Best-effort throughout: any failure (no KB, embedding
 * error, RPC error) degrades to fewer or zero results and never throws
 * into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingsConfig,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path.
  if (config.embeddingsApiKey && config.embeddingsProvider) {
    try {
      const [queryEmbedding] = await embedTexts(
        config.embeddingsProvider,
        config.embeddingsApiKey,
        [query],
        { kind: 'query' },
      )
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      const strictRows = !error && Array.isArray(data) ? (data as MatchRow[]) : null
      if (strictRows) {
        for (const row of strictRows) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }

      // The strict AND-query found nothing at all — decompose into
      // individual keyword searches rather than leaving a plainly
      // answerable question unanswered.
      const strictFoundNothing = !strictRows || strictRows.length === 0
      if (strictFoundNothing && picked.size < k) {
        await fillFromKeywordFallback(db, accountId, query, k, picked)
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
