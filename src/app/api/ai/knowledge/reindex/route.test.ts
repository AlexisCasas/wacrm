import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// POST /api/ai/knowledge/reindex — confirms the route correctly derives and
// passes embeddingsProvider through to ingestDocument for every document
// (the Gemini-embeddings addition), and that the pre-existing batch/error
// semantics are unchanged.
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acct-1'
const USER_ID = 'user-1'

let callerRole = 'admin'
let configRow: Record<string, unknown> | null = null
let documentRows: { id: string; title: string | null; content: string }[] = []

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
        return { data: configRow, error: null }
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(resolveResult()))
    // ai_knowledge_documents: select('id, title, content').eq('account_id', ...)
    // — no .maybeSingle(), the route awaits the builder directly.
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'ai_knowledge_documents') {
        return resolve({ data: documentRows, error: null })
      }
      return resolve(resolveResult())
    }
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
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}))

const { ingestDocument } = vi.hoisted(() => ({
  ingestDocument: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument }))

import { POST } from './route'

beforeEach(() => {
  callerRole = 'admin'
  configRow = null
  documentRows = []
  supabaseMock = makeSupabaseMock()
  ingestDocument.mockClear()
  ingestDocument.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/ai/knowledge/reindex', () => {
  it('reindexes every document and reports success (item: reindex funciona)', async () => {
    documentRows = [
      { id: 'doc-1', title: 'Title One', content: 'Doc one' },
      { id: 'doc-2', title: 'Title Two', content: 'Doc two' },
    ]
    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, reindexed: 2 })
    expect(ingestDocument).toHaveBeenCalledTimes(2)
  })

  it('derives embeddingsProvider="gemini" and passes it, WITH the document title, to ingestDocument', async () => {
    configRow = { provider: 'gemini', embeddings_api_key: 'enc:AIzaKey' }
    documentRows = [{ id: 'doc-1', title: 'Contacto y ubicación - Lorteg', content: 'Doc one' }]

    await POST()

    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: 'AIzaKey', embeddingsProvider: 'gemini' },
      'doc-1',
      'Contacto y ubicación - Lorteg',
      'Doc one',
    )
  })

  it('derives embeddingsProvider="openai" for an OpenAI chat account, still passing the title', async () => {
    configRow = { provider: 'openai', embeddings_api_key: 'enc:sk-key' }
    documentRows = [{ id: 'doc-1', title: 'Title One', content: 'Doc one' }]

    await POST()

    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: 'sk-key', embeddingsProvider: 'openai' },
      'doc-1',
      'Title One',
      'Doc one',
    )
  })

  it('reindexes lexical-only (embeddingsProvider null) when there is no embeddings key', async () => {
    configRow = null
    documentRows = [{ id: 'doc-1', title: 'Title One', content: 'Doc one' }]

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, reindexed: 1 })
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: null, embeddingsProvider: null },
      'doc-1',
      'Title One',
      'Doc one',
    )
  })

  it('stops immediately and reindexes nothing when the stored key cannot be decrypted', async () => {
    const { decrypt } = await import('@/lib/whatsapp/encryption')
    ;(decrypt as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('bad key')
    })
    configRow = { provider: 'gemini', embeddings_api_key: 'enc:corrupt' }
    documentRows = [{ id: 'doc-1', title: 'Title One', content: 'Doc one' }]

    const res = await POST()
    const json = await res.json()

    expect(json).toMatchObject({ success: false, reindexed: 0 })
    expect(ingestDocument).not.toHaveBeenCalled()
  })

  it('a failing document reports partial progress instead of aborting silently', async () => {
    documentRows = [
      { id: 'doc-1', title: 'Title One', content: 'Doc one' },
      { id: 'doc-2', title: 'Title Two', content: 'Doc two' },
    ]
    ingestDocument.mockResolvedValueOnce(undefined) // doc-1 succeeds
    ingestDocument.mockRejectedValueOnce(new Error('rate limited')) // doc-2 fails

    const res = await POST()
    const json = await res.json()

    expect(json.success).toBe(false)
    expect(json.reindexed).toBe(1)
    expect(json.error).toContain('rate limited')
  })
})
