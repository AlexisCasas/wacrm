import { describe, it, expect, vi } from 'vitest'
import { redactSecrets, providerHttpError } from './shared'

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

describe('redactSecrets', () => {
  it('redacts a single occurrence', () => {
    expect(redactSecrets('key is sk-abc123', ['sk-abc123'])).toBe('key is [REDACTED]')
  })

  it('redacts multiple occurrences of the same secret', () => {
    expect(redactSecrets('sk-abc123 ... again: sk-abc123', ['sk-abc123'])).toBe(
      '[REDACTED] ... again: [REDACTED]',
    )
  })

  it('redacts multiple distinct secrets in one pass', () => {
    expect(redactSecrets('a=key-one b=key-two', ['key-one', 'key-two'])).toBe(
      'a=[REDACTED] b=[REDACTED]',
    )
  })

  it('secrets with regex-special characters do not break sanitization (split/join, not regex)', () => {
    const weird = 'sk-a.b*c(d)e+f$g[h]i|j\\k'
    expect(redactSecrets(`token: ${weird} end`, [weird])).toBe('token: [REDACTED] end')
  })

  it('ignores empty/nullish secrets — the message is unchanged', () => {
    expect(redactSecrets('nothing to redact here', ['', null, undefined])).toBe(
      'nothing to redact here',
    )
  })

  it('an empty redact list leaves the message unchanged', () => {
    expect(redactSecrets('some message with sk-real-key', [])).toBe(
      'some message with sk-real-key',
    )
  })

  it('a secret not present in the text leaves the message unchanged', () => {
    expect(redactSecrets('unrelated message', ['sk-not-here'])).toBe('unrelated message')
  })
})

describe('providerHttpError — redaction', () => {
  it('redacts the secret from the provider detail message before building AiError', async () => {
    const res = errResponse(400, { error: { message: 'bad request, key=sk-leak-me was rejected' } })
    const err = await providerHttpError('TestProvider', res, { redact: ['sk-leak-me'] })
    expect(err.message).not.toContain('sk-leak-me')
    expect(err.message).toContain('[REDACTED]')
  })

  it('redacts every occurrence when the secret appears more than once', async () => {
    const res = errResponse(400, {
      error: { message: 'sk-dup rejected sk-dup, retry without sk-dup' },
    })
    const err = await providerHttpError('TestProvider', res, { redact: ['sk-dup'] })
    expect(err.message).not.toContain('sk-dup')
    expect(err.message.match(/\[REDACTED\]/g)).toHaveLength(3)
  })

  it('a secret with special characters is fully redacted', async () => {
    const weird = 'sk-a.b*c(d)e+f$g[h]i'
    const res = errResponse(400, { error: { message: `rejected: ${weird}` } })
    const err = await providerHttpError('TestProvider', res, { redact: [weird] })
    expect(err.message).not.toContain(weird)
    expect(err.message).toContain('[REDACTED]')
  })

  it('an empty/omitted redact list leaves the provider detail intact', async () => {
    const res = errResponse(400, { error: { message: 'plain error, nothing secret' } })
    const withEmpty = await providerHttpError('TestProvider', res, { redact: [] })
    expect(withEmpty.message).toContain('plain error, nothing secret')

    const res2 = errResponse(400, { error: { message: 'plain error, nothing secret' } })
    const withOmitted = await providerHttpError('TestProvider', res2)
    expect(withOmitted.message).toContain('plain error, nothing secret')
  })

  it.each([
    [401, 'invalid_key', 401],
    [403, 'invalid_key', 401],
    [429, 'rate_limited', 502],
    [500, 'provider_error', 502],
  ])(
    'status %i still maps to code %s / status %i, even with redaction active',
    async (upstreamStatus, expectedCode, expectedStatus) => {
      const res = errResponse(upstreamStatus, {
        error: { message: `upstream said no, key sk-should-be-gone` },
      })
      const err = await providerHttpError('TestProvider', res, { redact: ['sk-should-be-gone'] })
      expect(err.code).toBe(expectedCode)
      expect(err.status).toBe(expectedStatus)
      expect(err.message).not.toContain('sk-should-be-gone')
    },
  )

  it('never logs the secret, on success or on a redacted error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = errResponse(403, { error: { message: 'bad key sk-never-logged' } })
    await providerHttpError('TestProvider', res, { redact: ['sk-never-logged'] })

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    expect(logged).not.toContain('sk-never-logged')

    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })
})
