import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  embedTexts,
  embedTextsOpenAi,
  embedTextsGemini,
  toVectorLiteral,
  EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_CONCURRENCY,
} from './embeddings'
import { AiError } from './types'

const GEMINI_KEY = 'AIzaSyGeminiEmbeddingsKey'

function okEmbeddings(count: number, shuffle = false): Response {
  const rows = Array.from({ length: count }, (_, i) => ({
    embedding: [i, i + 0.5],
    index: i,
  }))
  if (shuffle) rows.reverse()
  return { ok: true, status: 200, json: async () => ({ data: rows }) } as unknown as Response
}

function geminiVector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => seed + i * 0.0001)
}

function geminiOkResponse(seed: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: geminiVector(seed) } }),
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })
})

describe('embedTextsOpenAi', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTextsOpenAi('sk-x', [])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('embeds a single batch and sends the key', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTextsOpenAi('sk-x', ['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(
      (opts as unknown as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer sk-x')
  })

  it('sends the raw input text — no asymmetric-retrieval prefix (Gemini-only feature)', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => okEmbeddings(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsOpenAi('sk-x', ['¿Dónde están ubicados?'])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input).toEqual(['¿Dónde están ubicados?'])
  })

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`)
    const out = await embedTextsOpenAi('sk-x', inputs)
    expect(out).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 96 + 4
  })

  it('reorders by index when the provider returns them shuffled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: { body: string }) => {
        const n = JSON.parse(opts.body).input.length
        return okEmbeddings(n, true)
      }),
    )
    const out = await embedTextsOpenAi('sk-x', ['a', 'b', 'c'])
    expect(out[0]).toEqual([0, 0.5]) // index 0 first despite shuffle
    expect(out[2]).toEqual([2, 2.5])
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response),
    )
    await expect(embedTextsOpenAi('sk-x', ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('throws when the provider omits result indices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }),
      } as unknown as Response),
    )
    await expect(embedTextsOpenAi('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response),
    )
    await expect(embedTextsOpenAi('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })

  it('redacts the key if OpenAI accidentally echoes it back in an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(401, { error: { message: `bad key sk-x` } })),
    )
    let caught: AiError | null = null
    try {
      await embedTextsOpenAi('sk-x', ['a'])
    } catch (err) {
      caught = err as AiError
    }
    expect(caught!.message).not.toContain('sk-x')
    expect(caught!.message).toContain('[REDACTED]')
  })
})

describe('embedTextsGemini — asymmetric-retrieval prompt format', () => {
  it('document embedding sends "title: {title} | text: {chunk}"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)

    await embedTextsGemini(GEMINI_KEY, ['Razón social...'], {
      kind: 'document',
      title: 'Contacto y ubicación - Lorteg',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).toBe(
      'title: Contacto y ubicación - Lorteg | text: Razón social...',
    )
  })

  it('document embedding with no title sends "title: none | text: {chunk}"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)

    await embedTextsGemini(GEMINI_KEY, ['Some content.'], { kind: 'document', title: null })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).toBe('title: none | text: Some content.')
  })

  it('document embedding with an empty/whitespace title also falls back to "none"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)

    await embedTextsGemini(GEMINI_KEY, ['Some content.'], { kind: 'document', title: '   ' })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).toBe('title: none | text: Some content.')
  })

  it('query embedding sends "task: question answering | query: {query}"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)

    await embedTextsGemini(GEMINI_KEY, ['¿Dónde están ubicados?'], { kind: 'query' })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).toBe(
      'task: question answering | query: ¿Dónde están ubicados?',
    )
  })

  it('the prefix is applied per-chunk when embedding several document chunks with the same title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)

    await embedTextsGemini(GEMINI_KEY, ['Chunk one.', 'Chunk two.'], {
      kind: 'document',
      title: 'Productos y categorías - Lorteg',
    })

    const texts = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as { body: string }).body).content.parts[0].text,
    )
    expect(texts).toContain('title: Productos y categorías - Lorteg | text: Chunk one.')
    expect(texts).toContain('title: Productos y categorías - Lorteg | text: Chunk two.')
  })

  it('never sends the raw unprefixed text to Gemini for a document embedding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['Razón social...'], { kind: 'document', title: 'T' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).not.toBe('Razón social...')
  })
})

describe('embedTextsGemini — request shape (endpoint, headers, dimensions)', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTextsGemini(GEMINI_KEY, [], { kind: 'query' })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the documented gemini-embedding-2 embedContent endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent',
    )
  })

  it('authenticates via x-goog-api-key, not Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-goog-api-key']).toBe(GEMINI_KEY)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('requests output_dimensionality: 1536', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.output_dimensionality).toBe(1536)
  })

  it('returns a valid 1536-length vector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    const [vec] = await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    expect(vec).toHaveLength(1536)
  })

  it('throws embeddings_malformed when the vector length is not 1536', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }),
      } as unknown as Response),
    )
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'embeddings_malformed' })
  })

  it('throws embeddings_malformed when a value is not a finite number', async () => {
    const bad = geminiVector(1)
    bad[10] = Number.NaN
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: bad } }),
      } as unknown as Response),
    )
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'embeddings_malformed' })
  })

  it('throws embeddings_malformed when values contains a non-number', async () => {
    const bad: unknown[] = geminiVector(1)
    bad[5] = 'not-a-number'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: bad } }),
      } as unknown as Response),
    )
    await expect(embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })).rejects.toBeInstanceOf(
      AiError,
    )
  })

  it('maps 403 to invalid_key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(403, { error: { message: 'API key not valid' } })),
    )
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(429, { error: { message: 'quota exceeded' } })),
    )
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('maps a timeout to code "timeout"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    )
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('maps a network failure to code "network_error"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')))
    await expect(
      embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }),
    ).rejects.toMatchObject({ code: 'network_error' })
  })

  it('never exposes the key in a thrown AiError, even if the upstream echoes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(403, { error: { message: `Rejected API key ${GEMINI_KEY}` } }),
      ),
    )
    let caught: AiError | null = null
    try {
      await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })
    } catch (err) {
      caught = err as AiError
    }
    expect(caught).toBeInstanceOf(AiError)
    expect(caught!.message).not.toContain(GEMINI_KEY)
    expect(caught!.message).toContain('[REDACTED]')
  })

  it('never logs the key, on success or failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiOkResponse(1)))
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'bad' } })))
    await embedTextsGemini(GEMINI_KEY, ['hola'], { kind: 'query' }).catch(() => {})

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    expect(logged).not.toContain(GEMINI_KEY)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('preserves input order across parallel requests', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body)
      const text = body.content.parts[0].text as string
      // text is the prefixed prompt ("task: question answering | query:
      // t0") — extract the seed from the trailing "tN".
      const seed = Number(text.match(/t(\d+)$/)?.[1])
      // Resolve out of order (t0 resolves LAST) to prove the OUTPUT
      // array order still matches the INPUT order, not arrival order.
      const delay = seed === 0 ? 20 : 0
      await new Promise((r) => setTimeout(r, delay))
      return geminiOkResponse(seed)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTextsGemini(GEMINI_KEY, ['t0', 't1', 't2'], { kind: 'query' })
    expect(out[0][0]).toBeCloseTo(0)
    expect(out[1][0]).toBeCloseTo(1)
    expect(out[2][0]).toBeCloseTo(2)
  })

  it('embeds one text per call — never folds multiple inputs into one embedContent request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTextsGemini(GEMINI_KEY, ['a', 'b', 'c'], { kind: 'document', title: 'T' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as { body: string }).body)
      expect(body.content.parts).toHaveLength(1)
    }
  })
})

describe('embedTextsGemini — bounded concurrency', () => {
  it(`never runs more than GEMINI_EMBEDDING_CONCURRENCY (${GEMINI_EMBEDDING_CONCURRENCY}) fetches at once`, async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => `t${i}`)
    let active = 0
    let maxActive = 0
    const releases: (() => void)[] = []

    const fetchMock = vi.fn(() => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          active--
          resolve(geminiOkResponse(1))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = embedTextsGemini(GEMINI_KEY, inputs, {
      kind: 'document',
      title: 'T',
    })

    // Let the worker pool spin up and issue its first wave of fetches.
    await new Promise((r) => setTimeout(r, 0))
    expect(active).toBe(GEMINI_EMBEDDING_CONCURRENCY)
    expect(fetchMock).toHaveBeenCalledTimes(GEMINI_EMBEDDING_CONCURRENCY)

    // Drain the queue by releasing whatever is currently pending, one
    // wave at a time, asserting the bound holds as finished workers pick
    // up the next item.
    let guard = 0
    while (releases.length > 0 && guard < 50) {
      guard++
      const wave = releases.splice(0, releases.length)
      wave.forEach((r) => r())
      await new Promise((r) => setTimeout(r, 0))
      expect(active).toBeLessThanOrEqual(GEMINI_EMBEDDING_CONCURRENCY)
    }

    await resultPromise
    expect(maxActive).toBe(GEMINI_EMBEDDING_CONCURRENCY)
    expect(fetchMock).toHaveBeenCalledTimes(20)
  })

  it('preserves input→output order even when the pool is concurrency-limited', async () => {
    const inputs = Array.from({ length: 12 }, (_, i) => `t${i}`)
    // Resolve in reverse-ish order to prove the RESULT array is indexed
    // by input position, not by completion order.
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const text = JSON.parse(opts.body).content.parts[0].text as string
      // text is the prefixed prompt — extract the seed from the trailing "tN".
      const seed = Number(text.match(/t(\d+)$/)?.[1])
      await new Promise((r) => setTimeout(r, (12 - seed) % 5))
      return geminiOkResponse(seed)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTextsGemini(GEMINI_KEY, inputs, { kind: 'query' })
    out.forEach((vec, i) => expect(vec[0]).toBeCloseTo(i))
  })

  it('a single failing call still rejects the whole batch (no silent partial results)', async () => {
    const inputs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const text = JSON.parse(opts.body).content.parts[0].text as string
      if (text.endsWith('d')) return errResponse(500, { error: { message: 'boom' } })
      return geminiOkResponse(1)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      embedTextsGemini(GEMINI_KEY, inputs, { kind: 'document', title: 'T' }),
    ).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('inputs=[] still makes no request under the concurrency-limited path', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTextsGemini(GEMINI_KEY, [], { kind: 'query' })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('embedTextsGemini — stops claiming new work after the first failure', () => {
  it('a failure among the first N in-flight calls stops the pool from ever starting item N+1 — in-flight calls still finish, then it rejects with the first error', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const releases: (() => void)[] = []
    let started = 0
    let settledCount = 0

    const fetchMock = vi.fn((_url: string, opts: { body: string }) => {
      started++
      const text = JSON.parse(opts.body).content.parts[0].text as string
      const seed = Number(text.match(/t(\d+)$/)?.[1])
      return new Promise<Response>((resolve, reject) => {
        releases.push(() => {
          settledCount++
          if (seed === 2) reject(new Error('boom from item 2'))
          else resolve(geminiOkResponse(seed))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = embedTextsGemini(GEMINI_KEY, inputs, { kind: 'query' })
    // Swallow here so the assertions below (which await it later) don't
    // race an "unhandled rejection" warning; the real assertion is at
    // the bottom via `.rejects`.
    const guarded = resultPromise.catch((e) => e)

    // Wave 1: the pool starts exactly GEMINI_EMBEDDING_CONCURRENCY (6)
    // requests — items 0-5.
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toBe(GEMINI_EMBEDDING_CONCURRENCY)

    // Fail item 2 (one of the first 6, still "in-flight" until now).
    releases[2]()
    await new Promise((r) => setTimeout(r, 0))

    // No item 6 (the 7th) was ever started, even though 5 of the
    // original 6 slots are still technically busy — the pool must not
    // claim new work once `stopped` is set, regardless of how many
    // other workers haven't yet noticed.
    expect(started).toBe(GEMINI_EMBEDDING_CONCURRENCY)

    // The other 5 requests that were ALREADY in flight before the
    // failure are allowed to finish normally — no forced abort.
    const stillPending = releases.filter((_, i) => i !== 2)
    expect(stillPending).toHaveLength(GEMINI_EMBEDDING_CONCURRENCY - 1)
    stillPending.forEach((release) => release())

    // The function must not have settled while those were still
    // pending — only once every started worker (in-flight ones
    // included) has actually finished.
    const result = await guarded
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('boom from item 2')

    // Still exactly 6 requests were ever made — never a 7th.
    expect(started).toBe(GEMINI_EMBEDDING_CONCURRENCY)
    expect(settledCount).toBe(GEMINI_EMBEDDING_CONCURRENCY)

    await expect(resultPromise).rejects.toThrow('boom from item 2')
  })

  it('happy path (no failures) still processes every item and preserves order under the stop-on-failure pool', async () => {
    const inputs = Array.from({ length: 9 }, (_, i) => `t${i}`)
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const text = JSON.parse(opts.body).content.parts[0].text as string
      const seed = Number(text.match(/t(\d+)$/)?.[1])
      return geminiOkResponse(seed)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTextsGemini(GEMINI_KEY, inputs, { kind: 'query' })
    expect(fetchMock).toHaveBeenCalledTimes(9)
    out.forEach((vec, i) => expect(vec[0]).toBeCloseTo(i))
  })
})

describe('embedTexts — provider dispatch', () => {
  it('provider="openai" calls OpenAI, ignoring the asymmetric-prompt options', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)
    await embedTexts('openai', 'sk-x', ['hola'], { kind: 'document', title: 'ignored' })
    expect(fetchMock.mock.calls[0][0]).toContain('api.openai.com')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input).toEqual(['hola'])
  })

  it('provider="gemini" calls Gemini and applies the query prompt format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    await embedTexts('gemini', GEMINI_KEY, ['hola'], { kind: 'query' })
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.content.parts[0].text).toBe('task: question answering | query: hola')
  })

  it('returns [] and makes no request for empty input, for either provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTexts('openai', 'sk-x', [], { kind: 'query' })).toEqual([])
    expect(await embedTexts('gemini', GEMINI_KEY, [], { kind: 'query' })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
