import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateGemini } from './gemini'
import { AiError } from '../types'
import type { ProviderArgs } from './shared'

const API_KEY = 'gemini-secret-key-xyz'

function baseArgs(overrides: Partial<ProviderArgs> = {}): ProviderArgs {
  return {
    apiKey: API_KEY,
    model: 'gemini-3.8-flash',
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hola' }],
    timeoutMs: 30_000,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

function successBody(text: string, usage?: Record<string, number>): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    ...(usage ? { usageMetadata: usage } : {}),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(successBody('Hi there!'))))
})
afterEach(() => vi.unstubAllGlobals())

describe('generateGemini — request shape', () => {
  it('calls the documented generateContent endpoint for the given model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs({ model: 'gemini-3.8-flash' }))

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    )
  })

  it('URL-encodes the model segment (safe path construction)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs({ model: 'weird/model name' }))

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/weird%2Fmodel%20name:generateContent',
    )
  })

  it('authenticates via the x-goog-api-key header, not Authorization/Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-goog-api-key']).toBe(API_KEY)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('sends the system prompt via systemInstruction.parts, never as a user message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs({ systemPrompt: 'Be concise and friendly.' }))

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be concise and friendly.' }] })
    expect(body.contents.some((c: { parts: { text: string }[] }) =>
      c.parts.some((p) => p.text === 'Be concise and friendly.'),
    )).toBe(false)
  })

  it('maps role "user" to Gemini role "user"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs({ messages: [{ role: 'user', content: 'Hi' }] }))

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }])
  })

  it('maps role "assistant" to Gemini role "model"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(
      baseArgs({
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello, how can I help?' },
          { role: 'user', content: 'What are your hours?' },
        ],
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Hello, how can I help?' }],
    })
  })

  it('merges consecutive same-role turns before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(
      baseArgs({
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'user', content: 'Are you open today?' },
        ],
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].parts[0].text).toBe('Hi\n\nAre you open today?')
  })

  it('sets generationConfig.maxOutputTokens to MAX_OUTPUT_TOKENS (1024)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.generationConfig.maxOutputTokens).toBe(1024)
  })

  it('sets thinkingConfig.thinkingLevel to "low"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  it('never sends temperature, topP, topK, candidateCount, or thinkingBudget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.generationConfig).not.toHaveProperty('temperature')
    expect(body.generationConfig).not.toHaveProperty('topP')
    expect(body.generationConfig).not.toHaveProperty('topK')
    expect(body.generationConfig).not.toHaveProperty('candidateCount')
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget')
  })

  it('does not request includeThoughts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(baseArgs())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('includeThoughts')
  })
})

describe('generateGemini — trailing model-turn edge case (no prefilled answer)', () => {
  it('drops a trailing assistant/model turn rather than asking Gemini to continue it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(
      baseArgs({
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Welcome! How can I help?' },
        ],
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }])
  })

  it('falls back to a neutral placeholder user turn when the history is bot-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini(
      baseArgs({ messages: [{ role: 'assistant', content: 'Welcome!' }] }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts[0].text).not.toBe('')
  })

  it('drops an empty-content message that survives merging (mergeConsecutive runs first, per spec)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(successBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    // Not consecutive with another same-role turn, so mergeConsecutive
    // leaves it standing alone — the empty-content filter then drops it.
    await generateGemini(
      baseArgs({
        messages: [
          { role: 'user', content: '   ' },
          { role: 'assistant', content: 'Hi, how can I help?' },
          { role: 'user', content: 'Real question' },
        ],
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents).toEqual([
      { role: 'model', parts: [{ text: 'Hi, how can I help?' }] },
      { role: 'user', parts: [{ text: 'Real question' }] },
    ])
  })
})

describe('generateGemini — response parsing', () => {
  it('parses candidates[0].content.parts[].text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(successBody('The answer is 42.'))))
    const result = await generateGemini(baseArgs())
    expect(result.text).toBe('The answer is 42.')
  })

  it('ignores parts marked thought: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'reasoning scratch work...', thought: true },
                  { text: 'Final visible answer.' },
                ],
              },
            },
          ],
        }),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.text).toBe('Final visible answer.')
    expect(result.text).not.toContain('reasoning scratch work')
  })

  it('concatenates multiple final text parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            { content: { parts: [{ text: 'Part one. ' }, { text: 'Part two.' }] } },
          ],
        }),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.text).toBe('Part one. Part two.')
  })

  it('throws empty_response on a 2xx with no usable text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ candidates: [{ content: { parts: [] } }] })),
    )
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({
      code: 'empty_response',
    })
  })

  it('throws empty_response when only thought parts are present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }] } }],
        }),
      ),
    )
    await expect(generateGemini(baseArgs())).rejects.toBeInstanceOf(AiError)
  })

  it('does not invent a fallback response body on empty_response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ candidates: [] })))
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({
      code: 'empty_response',
      message: 'Gemini returned an empty response.',
    })
  })
})

describe('generateGemini — usage normalization', () => {
  it('maps promptTokenCount to promptTokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(successBody('ok', { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 })),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.usage?.promptTokens).toBe(100)
  })

  it('maps candidatesTokenCount into completionTokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(successBody('ok', { promptTokenCount: 10, candidatesTokenCount: 30, totalTokenCount: 40 })),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.usage?.completionTokens).toBe(30)
  })

  it('adds thoughtsTokenCount into completionTokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          successBody('ok', {
            promptTokenCount: 10,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 15,
            totalTokenCount: 55,
          }),
        ),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.usage?.completionTokens).toBe(45) // 30 + 15
  })

  it('uses totalTokenCount as totalTokens when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          successBody('ok', { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 999 }),
        ),
      ),
    )
    const result = await generateGemini(baseArgs())
    expect(result.usage?.totalTokens).toBe(999)
  })

  it('tolerates missing usageMetadata entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(successBody('ok'))))
    const result = await generateGemini(baseArgs())
    expect(result.usage).toBeNull()
  })
})

describe('generateGemini — errors', () => {
  it('maps 403 to invalid_key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(403, { error: { message: 'API key not valid' } })),
    )
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('maps 401 to invalid_key too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'unauthorized' } })))
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(429, { error: { message: 'quota exceeded' } })),
    )
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('maps 500 to provider_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(500, { error: { message: 'internal error' } })),
    )
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('maps a timeout to code "timeout"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    )
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'timeout' })
  })

  it('maps a network failure to code "network_error"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')))
    await expect(generateGemini(baseArgs())).rejects.toMatchObject({ code: 'network_error' })
  })
})

describe('generateGemini — never exposes the API key', () => {
  it('redacts the FULL key when the upstream error body echoes it back verbatim', async () => {
    // Adversarial / accidental-upstream-leak case: the provider's own
    // error message contains the complete request API key, not a
    // truncated hint. providerHttpError's `redact` must strip it
    // entirely before the AiError is ever constructed.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(403, { error: { message: `Rejected API key ${API_KEY}` } }),
      ),
    )
    let caught: AiError | null = null
    try {
      await generateGemini(baseArgs())
    } catch (err) {
      caught = err as AiError
    }
    expect(caught).toBeInstanceOf(AiError)
    expect(caught!.message).not.toContain(API_KEY)
    expect(caught!.message).toContain('[REDACTED]')
  })

  it('the key never appears in the empty_response AiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ candidates: [] })))
    let caught: AiError | null = null
    try {
      await generateGemini(baseArgs())
    } catch (err) {
      caught = err as AiError
    }
    expect(caught!.message).not.toContain(API_KEY)
  })

  it('the key never appears in a network-error AiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    let caught: AiError | null = null
    try {
      await generateGemini(baseArgs())
    } catch (err) {
      caught = err as AiError
    }
    expect(caught!.message).not.toContain(API_KEY)
  })

  it('never logs the API key, on success or failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(successBody('ok'))))
    await generateGemini(baseArgs())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'bad key' } })))
    await generateGemini(baseArgs()).catch(() => {})

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    expect(logged).not.toContain(API_KEY)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })
})
