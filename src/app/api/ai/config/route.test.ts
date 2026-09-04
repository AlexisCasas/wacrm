import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Gemini-focused coverage for POST/GET /api/ai/config. Only exercises the
// parts of the route that change with a third provider — role enforcement,
// account scoping, "verify before save", and the rest of the existing
// behavior are assumed covered by the route's own long-standing design and
// are only spot-checked here where Gemini could plausibly regress them.
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acct-1'
const USER_ID = 'user-1'

let callerRole = 'admin'
let existingConfigRow: Record<string, unknown> | null = null
const insertCalls: { table: string; row: Record<string, unknown> }[] = []
const updateCalls: { table: string; row: Record<string, unknown> }[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select'
    let pendingRow: Record<string, unknown> | undefined

    const resolveResult = () => {
      if (mode === 'insert') {
        insertCalls.push({ table, row: pendingRow! })
        return { data: null, error: null }
      }
      if (mode === 'update') {
        updateCalls.push({ table, row: pendingRow! })
        return { data: null, error: null }
      }
      if (table === 'profiles') {
        return { data: { account_id: ACCOUNT_ID, account_role: callerRole }, error: null }
      }
      if (table === 'accounts') {
        return { data: { id: ACCOUNT_ID, name: 'Acme' }, error: null }
      }
      if (table === 'ai_configs') {
        return { data: existingConfigRow, error: null }
      }
      return { data: null, error: null }
    }

    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(resolveResult()))
    b.insert = vi.fn((row: Record<string, unknown>) => {
      mode = 'insert'
      pendingRow = row
      return b
    })
    b.update = vi.fn((row: Record<string, unknown>) => {
      mode = 'update'
      pendingRow = row
      return b
    })
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resolveResult()).then(resolve, reject)
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

const { embedTexts } = vi.hoisted(() => ({
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
}))
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts }))

import { GET, POST } from './route'
import { encrypt } from '@/lib/whatsapp/encryption'

function postConfig(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const GEMINI_BODY = {
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  api_key: 'AIzaSyGeminiTestKey',
  system_prompt: 'Be concise.',
  is_active: true,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
}

beforeEach(() => {
  callerRole = 'admin'
  existingConfigRow = null
  insertCalls.length = 0
  updateCalls.length = 0
  supabaseMock = makeSupabaseMock()
  validateAiCredentials.mockClear()
  validateAiCredentials.mockResolvedValue(undefined)
  embedTexts.mockClear()
  ;(encrypt as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/ai/config — accepts gemini', () => {
  it('accepts provider "gemini" and inserts a new config row', async () => {
    const res = await postConfig(GEMINI_BODY)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].row).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
    })
  })

  it('rejects an invalid provider with 400', async () => {
    const res = await postConfig({ ...GEMINI_BODY, provider: 'llama' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/provider must be/i)
    expect(insertCalls).toHaveLength(0)
  })
})

describe('POST /api/ai/config — Gemini key handling', () => {
  it('validates the Gemini key with the provider BEFORE persisting', async () => {
    let validatedBeforeInsert = false
    validateAiCredentials.mockImplementation(async () => {
      validatedBeforeInsert = insertCalls.length === 0
    })

    await postConfig(GEMINI_BODY)

    expect(validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', apiKey: 'AIzaSyGeminiTestKey' }),
    )
    expect(validatedBeforeInsert).toBe(true)
  })

  it('does not persist when Gemini key validation fails', async () => {
    const { AiError } = await import('@/lib/ai/types')
    validateAiCredentials.mockRejectedValue(
      new AiError('Gemini rejected the API key', { code: 'invalid_key', status: 401 }),
    )

    const res = await postConfig(GEMINI_BODY)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('invalid_key')
    expect(insertCalls).toHaveLength(0)
  })

  it('stores the Gemini key AES-256-GCM-encrypted via the existing encrypt(), never plaintext', async () => {
    await postConfig(GEMINI_BODY)

    expect(encrypt).toHaveBeenCalledWith('AIzaSyGeminiTestKey')
    expect(insertCalls[0].row.api_key).toBe('enc:AIzaSyGeminiTestKey')
    expect(insertCalls[0].row.api_key).not.toBe('AIzaSyGeminiTestKey')
  })
})

describe('GET /api/ai/config — never returns the key in plaintext', () => {
  it('returns has_key: true but no api_key field, for a Gemini config', async () => {
    existingConfigRow = {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      system_prompt: null,
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      handoff_agent_id: null,
      api_key: 'enc:AIzaSyGeminiTestKey',
      embeddings_api_key: null,
    }

    const res = await GET()
    const json = await res.json()

    expect(json.has_key).toBe(true)
    expect(json.provider).toBe('gemini')
    expect(json).not.toHaveProperty('api_key')
    expect(JSON.stringify(json)).not.toContain('AIzaSyGeminiTestKey')
  })
})

describe('POST /api/ai/config — provider switch revalidation', () => {
  it('switching OpenAI → Gemini triggers revalidation even without a new key', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'enc:sk-old-openai-key',
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      // No api_key — the stored (decrypted) OpenAI key gets reused as
      // the string handed to validateAiCredentials, but the important
      // thing is that a provider change alone still forces a live check.
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(res.status).toBe(200)
    expect(validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini' }),
    )
  })

  it('switching Gemini → Anthropic triggers revalidation', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaOldKey',
    }

    const res = await postConfig({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(res.status).toBe(200)
    expect(validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic' }),
    )
  })

  it('editing only the system prompt on an existing Gemini config does NOT re-call the provider', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaSameKey',
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      system_prompt: 'A brand new business context.',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(res.status).toBe(200)
    expect(validateAiCredentials).not.toHaveBeenCalled()
    expect(updateCalls[0].row).toMatchObject({ system_prompt: 'A brand new business context.' })
  })
})

describe('POST /api/ai/config — embeddings key stays separate for Gemini', () => {
  it('validates and encrypts an embeddings key independently of the Gemini chat key', async () => {
    const res = await postConfig({
      ...GEMINI_BODY,
      embeddings_api_key: 'sk-openai-embeddings-key',
    })

    expect(res.status).toBe(200)
    expect(embedTexts).toHaveBeenCalledWith('sk-openai-embeddings-key', ['ping'])
    // Two distinct encrypt() calls — the Gemini key and the embeddings key —
    // never the Gemini key reused as the embeddings key.
    expect(encrypt).toHaveBeenCalledWith('AIzaSyGeminiTestKey')
    expect(encrypt).toHaveBeenCalledWith('sk-openai-embeddings-key')
    expect(insertCalls[0].row.embeddings_api_key).toBe('enc:sk-openai-embeddings-key')
    expect(insertCalls[0].row.api_key).toBe('enc:AIzaSyGeminiTestKey')
    expect(insertCalls[0].row.embeddings_api_key).not.toBe(insertCalls[0].row.api_key)
  })

  it('omitting the embeddings key leaves it untouched, and Gemini works fine without one', async () => {
    const res = await postConfig(GEMINI_BODY)
    expect(res.status).toBe(200)
    expect(embedTexts).not.toHaveBeenCalled()
    expect(insertCalls[0].row).not.toHaveProperty('embeddings_api_key')
  })
})
