import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendManyChatText, ManyChatApiError } from './api'

const API_KEY = 'mc-secret-key-12345'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('sendManyChatText — request contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { status: 'success' }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the documented sendContent endpoint', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.manychat.com/fb/sending/sendContent')
  })

  it('sends the exact Bearer + Content-Type headers', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    })
  })

  it('uses content.type "whatsapp" and message type "text" (dynamic content v2)', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'Hola!' })
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      subscriber_id: 123,
      data: {
        version: 'v2',
        content: {
          type: 'whatsapp',
          messages: [{ type: 'text', text: 'Hola!' }],
        },
      },
    })
  })

  it('sends subscriber_id as a number when the ManyChat contact id is purely numeric', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '987654321', text: 'x' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.subscriber_id).toBe(987654321)
    expect(typeof body.subscriber_id).toBe('number')
  })

  it('passes an AbortController signal for the timeout', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns the raw parsed body on a 2xx response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'success' }))
    const result = await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    expect(result.raw).toEqual({ status: 'success' })
  })
})

describe('sendManyChatText — subscriber_id validation (fails BEFORE fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { status: 'success' }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['non-numeric string', 'abc-123'],
    ['zero', '0'],
    ['a value with a leading sign', '-123'],
    ['a decimal', '12.5'],
    ['an unsafe integer (past MAX_SAFE_INTEGER)', String(Number.MAX_SAFE_INTEGER + 1)],
    ['empty string', ''],
    ['whitespace', '  '],
  ])('rejects %s without calling fetch', async (_label, manyChatContactId) => {
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId, text: 'hi' }),
    ).rejects.toBeInstanceOf(ManyChatApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the thrown error is a 400 with no network call made', async () => {
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: 'not-a-number', text: 'hi' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a positive safe integer string and sends it as a number', async () => {
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123456789', text: 'hi' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.subscriber_id).toBe(123456789)
    expect(Number.isSafeInteger(body.subscriber_id)).toBe(true)
  })

  it('accepts the largest safe integer', async () => {
    await sendManyChatText({
      apiKey: API_KEY,
      manyChatContactId: String(Number.MAX_SAFE_INTEGER),
      text: 'hi',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.subscriber_id).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('sendManyChatText — 2xx responses must confirm status: "success"', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a 200 with status: "success"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { status: 'success' })))
    const result = await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    expect(result.raw).toEqual({ status: 'success' })
  })

  it('rejects a 200 with status: "error"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { status: 'error', message: 'not delivered' })),
    )
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toBeInstanceOf(ManyChatApiError)
  })

  it('rejects a 200 with no status field at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { unexpected: 'shape' })))
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toBeInstanceOf(ManyChatApiError)
  })

  it('rejects a 200 with an unparseable (non-JSON) body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })) as unknown as typeof fetch,
    )
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toBeInstanceOf(ManyChatApiError)
  })

  it('a rejected 2xx does not silently look like success — status is not itself 2xx-coded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { status: 'error' })))
    let caught: ManyChatApiError | null = null
    try {
      await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    } catch (err) {
      caught = err as ManyChatApiError
    }
    expect(caught).toBeInstanceOf(ManyChatApiError)
    // Distinct from a plain HTTP failure — callers can tell "ManyChat said
    // 200 but the payload disputes it" apart from a transport-level error.
    expect(caught!.status).toBe(502)
  })
})

describe('sendManyChatText — error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([401, 403, 429, 500])('throws a typed ManyChatApiError on HTTP %i', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(status, { status: 'error', message: `boom ${status}` })),
    )
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toMatchObject({
      status,
      message: `boom ${status}`,
    })
  })

  it('throws ManyChatApiError instances specifically', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { message: 'boom' })))
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toBeInstanceOf(ManyChatApiError)
  })

  it('falls back to a generic message when the error body has no message field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { status: 'error' })))
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toMatchObject({ status: 500, message: 'ManyChat API error: HTTP 500' })
  })

  it('surfaces a network failure as a 502 ManyChatApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    )
    await expect(
      sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('surfaces an aborted request as a 504 timeout ManyChatApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }),
    )
    await expect(
      sendManyChatText({
        apiKey: API_KEY,
        manyChatContactId: '123',
        text: 'hi',
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ status: 504 })
  })

  it('redacts the literal API key if it ever appears in an error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(400, { message: `invalid token ${API_KEY}`, echoed_auth: `Bearer ${API_KEY}` }),
      ),
    )
    let caught: ManyChatApiError | null = null
    try {
      await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    } catch (err) {
      caught = err as ManyChatApiError
    }
    expect(caught).toBeInstanceOf(ManyChatApiError)
    expect(caught!.message).not.toContain(API_KEY)
    expect(JSON.stringify(caught!.body)).not.toContain(API_KEY)
  })
})

describe('sendManyChatText — never logs the API key', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  function loggedText(): string {
    return [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n')
  }

  it('on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { status: 'success' })))
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' })
    expect(loggedText()).not.toContain(API_KEY)
  })

  it('on a ManyChat error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { message: 'unauthorized' })))
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }).catch(() => {})
    expect(loggedText()).not.toContain(API_KEY)
  })

  it('on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    await sendManyChatText({ apiKey: API_KEY, manyChatContactId: '123', text: 'hi' }).catch(() => {})
    expect(loggedText()).not.toContain(API_KEY)
  })
})
