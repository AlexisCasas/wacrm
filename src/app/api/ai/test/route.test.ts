import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Gemini-focused coverage for POST /api/ai/test ("Test key" button).
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acct-1'
const USER_ID = 'user-1'

let callerRole = 'admin'
let storedConfigRow: Record<string, unknown> | null = null

function makeSupabaseMock() {
  function builder(table: string) {
    const resolveResult = () => {
      if (table === 'profiles') {
        return { data: { account_id: ACCOUNT_ID, account_role: callerRole }, error: null }
      }
      if (table === 'accounts') {
        return { data: { id: ACCOUNT_ID, name: 'Acme' }, error: null }
      }
      if (table === 'ai_configs') {
        return { data: storedConfigRow, error: null }
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(resolveResult()))
    return b
  }
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}))

const { validateAiCredentials } = vi.hoisted(() => ({
  validateAiCredentials: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials }))

import { POST } from './route'

function postTest(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  callerRole = 'admin'
  storedConfigRow = null
  supabaseMock = makeSupabaseMock()
  validateAiCredentials.mockClear()
  validateAiCredentials.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/ai/test — accepts gemini', () => {
  it('validates a Gemini key via validateAiCredentials → generateReply → generateGemini', async () => {
    const res = await postTest({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'AIzaSyGeminiTestKey',
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        apiKey: 'AIzaSyGeminiTestKey',
      }),
    )
  })

  it('rejects an invalid provider with 400, still', async () => {
    const res = await postTest({ provider: 'llama', model: 'x', api_key: 'k' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/provider must be/i)
    expect(validateAiCredentials).not.toHaveBeenCalled()
  })

  it('surfaces a Gemini invalid_key rejection as 400 with the code', async () => {
    const { AiError } = await import('@/lib/ai/types')
    validateAiCredentials.mockRejectedValue(
      new AiError('Gemini rejected the API key', { code: 'invalid_key', status: 401 }),
    )
    const res = await postTest({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'bad-key',
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('invalid_key')
  })

  it('reuses the stored (decrypted) key when none is supplied, and never echoes it back', async () => {
    storedConfigRow = { api_key: 'enc:AIzaStoredKey' }

    const res = await postTest({ provider: 'gemini', model: 'gemini-3.8-flash' })

    expect(res.status).toBe(200)
    expect(validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'AIzaStoredKey' }),
    )
    const json = await res.json()
    expect(JSON.stringify(json)).not.toContain('AIzaStoredKey')
  })

  it('never logs the API key on a failed validation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { AiError } = await import('@/lib/ai/types')
    validateAiCredentials.mockRejectedValue(
      new AiError('rejected', { code: 'invalid_key', status: 401 }),
    )

    await postTest({ provider: 'gemini', model: 'gemini-3.8-flash', api_key: 'AIzaSecretHere' })

    const logged = errorSpy.mock.calls
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    expect(logged).not.toContain('AIzaSecretHere')
    errorSpy.mockRestore()
  })
})
