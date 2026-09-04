import { AiError, type EmbeddingsProvider } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Embeddings — OpenAI and Gemini.
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so an Anthropic-chat account with an
// embeddings key still uses OpenAI here (see `deriveEmbeddingsProvider`
// in config.ts). Both providers produce 1536-dim vectors, matching the
// single `vector(1536)` column in migration 030 — no pgvector schema
// change for adding Gemini.
// ============================================================

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
const GEMINI_EMBEDDINGS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2'
export const EMBEDDING_DIMENSIONS = 1536

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96

// Gemini's embedContent has no batch endpoint we rely on (see
// embedTextsGemini below), so a big re-index would otherwise fire one
// fetch per chunk with no cap. 6 is a conservative default: enough to
// keep a re-index fast, low enough to stay well clear of a BYO key's
// per-account rate limit on a single request burst.
export const GEMINI_EMBEDDING_CONCURRENCY = 6

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
}

interface GeminiEmbedContentResponse {
  embedding?: { values?: unknown }
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Which side of retrieval a string is being embedded for. Gemini's
 * embedContent has no `task_type` field for gemini-embedding-2 (unlike
 * the older gemini-embedding-001) — Google's current guidance is to
 * encode the task directly in the text instead (see `toGeminiPrompt`).
 * OpenAI ignores this entirely; it always embeds the raw text.
 */
export type EmbeddingKind = 'query' | 'document'

export interface EmbedOptions {
  kind: EmbeddingKind
  /** Document title — only used for kind:'document' with Gemini, to
   *  build `title: {title} | text: {chunk}`. Ignored for kind:'query'
   *  and for OpenAI. Defaults to 'none' when absent/empty, matching
   *  Google's documented format for untitled documents. */
  title?: string | null
}

/**
 * Build Gemini's recommended asymmetric-retrieval prompt for
 * gemini-embedding-2. Applied ONLY to the text sent to Gemini for
 * embedding — never to what's persisted (`ai_knowledge_chunks.content`
 * stores the raw chunk, unprefixed) and never to OpenAI, which embeds
 * the original text as-is.
 */
function toGeminiPrompt(options: EmbedOptions, text: string): string {
  if (options.kind === 'query') {
    return `task: question answering | query: ${text}`
  }
  const title = options.title && options.title.trim() ? options.title.trim() : 'none'
  return `title: ${title} | text: ${text}`
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once,
 * preserving output order to match input order regardless of which
 * call finishes first. A worker-pool: `limit` workers pull the next
 * unclaimed index off a shared cursor until the queue is drained. No
 * new dependency — this is the whole implementation.
 *
 * Stops claiming NEW work as soon as any call fails — a worker checks
 * the shared `stopped` flag before taking its next index, so once one
 * fails, no further requests are started. This is deliberately NOT
 * just "reject once and let `Promise.all` walk away": with a naive
 * pool, workers B–F would keep pulling and firing new requests after
 * worker A's failure while the caller had already moved on believing
 * the batch was done. In-flight calls (already `await`ing `fn`) are
 * left to finish normally — no forced abort, no retries — and this
 * function does not return/throw until every started worker (in-
 * flight ones included) has actually finished. Then, if anything
 * failed, it throws the FIRST error seen (later ones are dropped).
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let stopped = false
  let hasError = false
  let firstError: unknown

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      const i = nextIndex++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        if (!hasError) {
          hasError = true
          firstError = err
        }
        stopped = true
        return
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  // Waits for every worker — including ones mid-flight when `stopped`
  // was set — so the function never resolves/rejects while a request
  // is still running in the background.
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (hasError) throw firstError
  return results
}

/**
 * Embed a list of strings with OpenAI, preserving input order. Batched;
 * throws `AiError` on provider/network failure so callers can decide
 * whether to degrade (retrieval) or surface (ingest). Always embeds the
 * raw input text — OpenAI has no asymmetric-retrieval prompt format to
 * apply here.
 */
export async function embedTextsOpenAi(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    let res: Response
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res, { redact: [apiKey] })
    }

    const data = (await res.json().catch(() => null)) as OpenAiEmbeddingResponse | null
    const rows = data?.data
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      })
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.embedding)
    }
  }

  return out
}

/**
 * Embed one already-formatted prompt string with Gemini's `embedContent`
 * REST endpoint, requesting `output_dimensionality: 1536` so the vector
 * matches the same `vector(1536)` column OpenAI's text-embedding-3-small
 * already uses.
 */
async function embedOneGemini(apiKey: string, prompt: string): Promise<number[]> {
  const timeoutMs = aiRequestTimeoutMs()

  let res: Response
  try {
    res = await fetch(GEMINI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: { parts: [{ text: prompt }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini embeddings', res, { redact: [apiKey] })
  }

  const data = (await res.json().catch(() => null)) as GeminiEmbedContentResponse | null
  const values = data?.embedding?.values
  if (
    !Array.isArray(values) ||
    values.length !== EMBEDDING_DIMENSIONS ||
    !values.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new AiError('Gemini embeddings response was malformed.', {
      code: 'embeddings_malformed',
    })
  }
  return values as number[]
}

/**
 * Embed a list of strings with Gemini, preserving input order.
 *
 * Each input is first wrapped in Google's recommended asymmetric prompt
 * (`toGeminiPrompt` — query vs document format; see module docs) — the
 * wrapped text is what's sent to Gemini, never what's persisted.
 *
 * One `embedContent` call per input — Gemini's single-content endpoint
 * embeds exactly one piece of content, so this deliberately does NOT
 * fold multiple chunks into one call (that would silently produce one
 * vector for several chunks' worth of text). Calls run with at most
 * `GEMINI_EMBEDDING_CONCURRENCY` in flight at once (see
 * `mapWithConcurrencyLimit`), which also preserves the input order in
 * the returned array regardless of completion order.
 */
export async function embedTextsGemini(
  apiKey: string,
  inputs: string[],
  options: EmbedOptions,
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const prompts = inputs.map((text) => toGeminiPrompt(options, text))
  return mapWithConcurrencyLimit(prompts, GEMINI_EMBEDDING_CONCURRENCY, (prompt) =>
    embedOneGemini(apiKey, prompt),
  )
}

/**
 * Dispatch to the account's configured embeddings provider. `provider`
 * comes from `AiConfig.embeddingsProvider` (derived in config.ts from
 * the chat provider + presence of an embeddings key) — never guessed
 * from the key's shape/prefix. `options` tells the Gemini path whether
 * this is a query or document embedding (and the document's title,
 * when applicable) — OpenAI ignores it.
 */
export async function embedTexts(
  provider: EmbeddingsProvider,
  apiKey: string,
  inputs: string[],
  options: EmbedOptions,
): Promise<number[][]> {
  if (inputs.length === 0) return []
  return provider === 'gemini'
    ? embedTextsGemini(apiKey, inputs, options)
    : embedTextsOpenAi(apiKey, inputs)
}
