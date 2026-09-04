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
/** Set to force the ai_knowledge_chunks clear-update to fail. */
let chunksClearError: { message: string } | null = null
/** Set to force the ai_configs insert/update (the config save) to fail. */
let configSaveError: { message: string } | null = null
const insertCalls: { table: string; row: Record<string, unknown> }[] = []
const updateCalls: {
  table: string
  row: Record<string, unknown>
  eqArgs: [string, unknown][]
}[] = []
const deleteCalls: { table: string; eqArgs: [string, unknown][] }[] = []
/** Records 'clear' / 'config-write' in the order the route actually issues
 *  them, so ordering (not just occurrence) can be asserted directly. */
const writeOrder: ('clear' | 'config-write')[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let pendingRow: Record<string, unknown> | undefined
    const eqArgs: [string, unknown][] = []

    const resolveResult = () => {
      if (mode === 'insert') {
        insertCalls.push({ table, row: pendingRow! })
        if (table === 'ai_configs') {
          writeOrder.push('config-write')
          if (configSaveError) return { data: null, error: configSaveError }
        }
        return { data: null, error: null }
      }
      if (mode === 'update') {
        updateCalls.push({ table, row: pendingRow!, eqArgs: [...eqArgs] })
        if (table === 'ai_knowledge_chunks') {
          writeOrder.push('clear')
          if (chunksClearError) return { data: null, error: chunksClearError }
          return { data: null, error: null }
        }
        if (table === 'ai_configs') {
          writeOrder.push('config-write')
          if (configSaveError) return { data: null, error: configSaveError }
        }
        return { data: null, error: null }
      }
      if (mode === 'delete') {
        deleteCalls.push({ table, eqArgs: [...eqArgs] })
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
    b.eq = vi.fn((col: string, val: unknown) => {
      eqArgs.push([col, val])
      return b
    })
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
    b.delete = vi.fn(() => {
      mode = 'delete'
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
  chunksClearError = null
  configSaveError = null
  insertCalls.length = 0
  updateCalls.length = 0
  deleteCalls.length = 0
  writeOrder.length = 0
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
  it('validates and encrypts an embeddings key as a SEPARATE field from the Gemini chat key (explicit opt-in, no auto-reuse)', async () => {
    // The user pastes a distinct value into the embeddings field — even
    // though provider=gemini (so this gets validated as a Gemini
    // embeddings key), it must never be silently copied from api_key.
    const res = await postConfig({
      ...GEMINI_BODY,
      embeddings_api_key: 'AIzaSyDistinctEmbeddingsKey',
    })

    expect(res.status).toBe(200)
    // provider=gemini → the embeddings key is validated as a Gemini key,
    // never guessed by the key's shape/prefix.
    expect(embedTexts).toHaveBeenCalledWith('gemini', 'AIzaSyDistinctEmbeddingsKey', ['ping'], {
      kind: 'query',
    })
    // Two distinct encrypt() calls — the chat key and the embeddings key —
    // never the chat key reused as the embeddings key.
    expect(encrypt).toHaveBeenCalledWith('AIzaSyGeminiTestKey')
    expect(encrypt).toHaveBeenCalledWith('AIzaSyDistinctEmbeddingsKey')
    expect(insertCalls[0].row.embeddings_api_key).toBe('enc:AIzaSyDistinctEmbeddingsKey')
    expect(insertCalls[0].row.api_key).toBe('enc:AIzaSyGeminiTestKey')
    expect(insertCalls[0].row.embeddings_api_key).not.toBe(insertCalls[0].row.api_key)
  })

  it('accepts the SAME Gemini key pasted into both the chat and embeddings fields (explicit opt-in reuse)', async () => {
    const res = await postConfig({
      ...GEMINI_BODY,
      embeddings_api_key: 'AIzaSyGeminiTestKey', // same value as api_key
    })

    expect(res.status).toBe(200)
    expect(embedTexts).toHaveBeenCalledWith('gemini', 'AIzaSyGeminiTestKey', ['ping'], {
      kind: 'query',
    })
    expect(insertCalls[0].row.embeddings_api_key).toBe('enc:AIzaSyGeminiTestKey')
  })

  it('omitting the embeddings key leaves it untouched, and Gemini works fine without one', async () => {
    const res = await postConfig(GEMINI_BODY)
    expect(res.status).toBe(200)
    expect(embedTexts).not.toHaveBeenCalled()
    expect(insertCalls[0].row).not.toHaveProperty('embeddings_api_key')
  })
})

describe('POST /api/ai/config — embeddings provider selection by chat provider', () => {
  it('provider=openai + embeddings key → validated as OpenAI embeddings', async () => {
    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-openai-chat-key',
      embeddings_api_key: 'sk-openai-embed-key',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    expect(res.status).toBe(200)
    expect(embedTexts).toHaveBeenCalledWith('openai', 'sk-openai-embed-key', ['ping'], { kind: 'query' })
  })

  it('provider=anthropic + embeddings key → still validated as OpenAI embeddings (Anthropic has no embeddings endpoint)', async () => {
    const res = await postConfig({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      api_key: 'sk-ant-chat-key',
      embeddings_api_key: 'sk-openai-embed-key',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    expect(res.status).toBe(200)
    expect(embedTexts).toHaveBeenCalledWith('openai', 'sk-openai-embed-key', ['ping'], { kind: 'query' })
  })
})

describe('POST /api/ai/config — clears stale embeddings on an embedding-space change (fail-safe ordering: clear BEFORE save)', () => {
  function chunksClearCall() {
    return updateCalls.find((c) => c.table === 'ai_knowledge_chunks')
  }

  it('gemini → openai: clear ocurre ANTES del save (update) de ai_configs', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaOldChat',
      embeddings_api_key: 'enc:AIzaOldEmbed',
    }

    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      // embeddings_api_key omitted → the existing embeddings key carries
      // over unchanged; only the CHAT provider (and thus the derived
      // embeddings provider) changes.
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBe(true)
    const clearCall = chunksClearCall()
    expect(clearCall).toBeDefined()
    expect(clearCall!.row).toEqual({ embedding: null })
    // Ordering proof: the clear must be issued strictly before the config
    // write, not just "also happen".
    expect(writeOrder).toEqual(['clear', 'config-write'])
  })

  it('openai → gemini: clear ocurre ANTES del save', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'enc:sk-old-chat',
      embeddings_api_key: 'enc:sk-old-embed',
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'AIzaNewChat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBe(true)
    expect(chunksClearCall()).toBeDefined()
    expect(writeOrder).toEqual(['clear', 'config-write'])
  })

  it('gemini + key → gemini with the key explicitly cleared: clears embeddings', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      embeddings_api_key: null, // explicit clear
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBe(true)
    expect(chunksClearCall()).toBeDefined()
  })

  it('no embeddings key → gemini + key: clears (idempotent even if already NULL)', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'enc:sk-old-chat',
      embeddings_api_key: null,
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'AIzaNewChat',
      embeddings_api_key: 'AIzaNewEmbed',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBe(true)
    expect(chunksClearCall()).toBeDefined()
  })

  it('the clear is scoped strictly by account_id', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    const clearCall = chunksClearCall()
    expect(clearCall!.eqArgs).toEqual([['account_id', ACCOUNT_ID]])
  })

  it('never deletes documents or chunks — only NULLs the embedding column', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(deleteCalls).toHaveLength(0)
    // The update touches ONLY the embedding column — title/content/fts
    // untouched (the route doesn't even have those values to write).
    expect(chunksClearCall()!.row).toEqual({ embedding: null })
  })

  it('openai → anthropic does NOT clear (both use OpenAI embeddings)', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'enc:sk-old-chat',
      embeddings_api_key: 'enc:sk-embed',
    }

    const res = await postConfig({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      api_key: 'sk-ant-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBeUndefined()
    expect(chunksClearCall()).toBeUndefined()
    expect(writeOrder).toEqual(['config-write'])
  })

  it('same-provider embeddings key rotation (OpenAI key A → key B) does NOT clear', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'enc:sk-chat',
      embeddings_api_key: 'enc:sk-embed-A',
    }

    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      embeddings_api_key: 'sk-embed-B',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBeUndefined()
    expect(chunksClearCall()).toBeUndefined()
  })

  it('same-provider embeddings key rotation (Gemini key A → key B) does NOT clear', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbedA',
    }

    const res = await postConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      embeddings_api_key: 'AIzaEmbedB',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.knowledge_reindex_required).toBeUndefined()
    expect(chunksClearCall()).toBeUndefined()
  })

  it('a successful provider-change save reports knowledge_reindex_required: true', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }

    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.knowledge_reindex_required).toBe(true)
  })
})

describe('POST /api/ai/config — fail-safe: if the clear fails, the new config is NEVER saved', () => {
  function chunksClearCall() {
    return updateCalls.find((c) => c.table === 'ai_knowledge_chunks')
  }
  function configWriteCalls() {
    return [
      ...insertCalls.filter((c) => c.table === 'ai_configs'),
      ...updateCalls.filter((c) => c.table === 'ai_configs'),
    ]
  }

  it('si clear falla: el save de ai_configs NO se ejecuta', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    chunksClearError = { message: 'db unreachable' }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(chunksClearCall()).toBeDefined() // the clear WAS attempted
    expect(configWriteCalls()).toHaveLength(0) // but the config write never ran
    expect(writeOrder).toEqual(['clear']) // proves the write never followed
  })

  it('si clear falla: la respuesta no es success:true — es un error HTTP seguro (500), sin detalles internos de la DB', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    chunksClearError = { message: 'password authentication failed for user "postgres"' }

    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBeUndefined()
    expect(json.knowledge_reindex_required).toBeUndefined()
    expect(typeof json.error).toBe('string')
    // Generic, safe message — never the raw DB error text.
    expect(json.error).not.toContain('postgres')
    expect(json.error).not.toContain('password')
  })

  it('si clear falla: el provider/config anterior permanece intacto (ningún insert/update de ai_configs se emitió)', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    chunksClearError = { message: 'db unreachable' }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    // Nothing touched ai_configs at all — the stored row (provider, model,
    // keys) is exactly what it was before this request.
    expect(insertCalls.filter((c) => c.table === 'ai_configs')).toHaveLength(0)
    expect(updateCalls.filter((c) => c.table === 'ai_configs')).toHaveLength(0)
  })

  it('si el clear funciona pero el save de config falla: el clear ya ocurrió y NO se intenta restaurar el vector viejo', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    configSaveError = { message: 'db unreachable' }

    const res = await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBeUndefined()
    // The clear happened and is NOT rolled back — chunks.embedding stays
    // NULL; this is the accepted safe outcome (lexical search still
    // works, semantic search is temporarily unavailable until Reindex).
    expect(chunksClearCall()).toBeDefined()
    expect(writeOrder).toEqual(['clear', 'config-write'])
    // Only ONE update call ever touched ai_knowledge_chunks — no second
    // "restore"/rollback update was issued.
    expect(updateCalls.filter((c) => c.table === 'ai_knowledge_chunks')).toHaveLength(1)
  })

  it('la clear query sigue scoped por account_id incluso en el camino fail-safe', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    chunksClearError = { message: 'db unreachable' }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    const clearCall = chunksClearCall()
    expect(clearCall!.eqArgs).toEqual([['account_id', ACCOUNT_ID]])
  })

  it('jamás emite un DELETE sobre documents/chunks, ni en el camino exitoso ni en el fail-safe', async () => {
    existingConfigRow = {
      id: 'cfg-1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      api_key: 'enc:AIzaChat',
      embeddings_api_key: 'enc:AIzaEmbed',
    }
    chunksClearError = { message: 'db unreachable' }

    await postConfig({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      api_key: 'sk-new-chat',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
    })

    expect(deleteCalls).toHaveLength(0)
  })
})
