import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  /** Set on a reasoning/"thinking" part. We never request these
   *  (`includeThoughts` is not sent) but parse defensively anyway. */
  thought?: boolean
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: { text: string }[]
}

/**
 * Gemini expects the conversation as `contents` with roles 'user' /
 * 'model' (our `ChatMessage` uses 'user' / 'assistant') and generates
 * the NEXT turn after the last entry — which only makes sense when the
 * transcript ends on the customer's turn (the normal CRM case: the
 * customer just wrote in).
 *
 * Defensively drop any trailing model-role turns rather than asking
 * Gemini to continue its own last message — this never mutates the
 * persisted conversation (it only reshapes a local copy for the
 * request) and never fabricates a "prefilled" model answer. Falls back
 * to a neutral placeholder user turn only if that leaves nothing at
 * all (e.g. history is bot-only so far) — mirrors the Anthropic
 * adapter's analogous edge case (see `normalizeForAnthropic`).
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const merged = mergeConsecutive(messages).filter((m) => m.content.trim().length > 0)
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop()
  }
  const turns =
    merged.length > 0
      ? merged
      : [{ role: 'user' as const, content: '(The customer has not sent a message yet.)' }]
  return turns.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Gemini's `generateContent` REST endpoint with the caller's own
 * key. Returns the raw assistant text + token usage (handoff parsing
 * happens in `generateReply`).
 *
 * Fixed at `thinkingLevel: 'low'` for this first version — WA CRM is
 * conversational chat support, where reply latency and per-message
 * cost matter more than deeper reasoning. Not yet exposed as a user
 * setting; no `temperature`/`topP`/`topK`/`candidateCount`/
 * `thinkingBudget` are sent (gemini-3.8-flash uses `thinkingLevel`,
 * not `thinkingBudget`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  // Build the model path safely — `model` is free text from the
  // settings form and goes straight into the URL, so it's encoded
  // rather than interpolated raw.
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(messages),
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res, { redact: [apiKey] })
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null

  // Only final text parts — a `thought === true` part is reasoning
  // scratch-space, never shown to the customer, even though we don't
  // request it via includeThoughts.
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usageMeta = data?.usageMetadata
  // "Completion" spend includes thinking tokens — they're real spend
  // against the account's key even though their content never reaches
  // the customer.
  const usage = normalizeUsage({
    prompt: usageMeta?.promptTokenCount,
    completion: (usageMeta?.candidatesTokenCount ?? 0) + (usageMeta?.thoughtsTokenCount ?? 0),
    total: usageMeta?.totalTokenCount,
  })

  return { text, usage }
}
