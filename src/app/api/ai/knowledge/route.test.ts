import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// POST /api/ai/knowledge — focused on confirming `title` is threaded through
// to ingestDocument() correctly (Gemini's asymmetric document format needs
// it). Role/account-scoping/rate-limit behavior is unchanged and not
// re-tested here.
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acct-1'
const USER_ID = 'user-1'

let callerRole = 'admin'
let embeddingsKeyResult: {
  key: string | null
  corrupt: boolean
  provider: 'openai' | 'gemini' | null
} = { key: null, corrupt: false, provider: null }
const insertedDocs: Record<string, unknown>[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    let inserted: Record<string, unknown> | undefined
    const resolveResult = () => {
      if (table === 'profiles') {
        return { data: { account_id: ACCOUNT_ID, account_role: callerRole }, error: null }
      }
      if (table === 'accounts') {
        return { data: { id: ACCOUNT_ID, name: 'Acme' }, error: null }
      }
      if (table === 'ai_knowledge_documents' && inserted) {
        insertedDocs.push(inserted)
        return { data: { id: 'doc-new' }, error: null }
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(resolveResult()))
    b.single = vi.fn(() => Promise.resolve(resolveResult()))
    b.insert = vi.fn((row: Record<string, unknown>) => {
      inserted = row
      return b
    })
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

const { loadEmbeddingsKey } = vi.hoisted(() => ({
  loadEmbeddingsKey: vi.fn(),
}))
vi.mock('@/lib/ai/config', () => ({ loadEmbeddingsKey }))

const { ingestDocument } = vi.hoisted(() => ({
  ingestDocument: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument }))

import { POST } from './route'

function postKnowledge(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/ai/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  callerRole = 'admin'
  insertedDocs.length = 0
  embeddingsKeyResult = { key: null, corrupt: false, provider: null }
  supabaseMock = makeSupabaseMock()
  loadEmbeddingsKey.mockClear()
  loadEmbeddingsKey.mockImplementation(async () => embeddingsKeyResult)
  ingestDocument.mockClear()
  ingestDocument.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/ai/knowledge', () => {
  it('passes the document title through to ingestDocument (lexical-only)', async () => {
    const res = await postKnowledge({
      title: 'Contacto y ubicación - Lorteg',
      content: 'Razón social...',
    })
    expect(res.status).toBe(200)
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: null, embeddingsProvider: null },
      'doc-new',
      'Contacto y ubicación - Lorteg',
      'Razón social...',
    )
  })

  it('passes the title through when Gemini embeddings are configured', async () => {
    embeddingsKeyResult = { key: 'AIzaKey', corrupt: false, provider: 'gemini' }
    const res = await postKnowledge({
      title: 'Productos y categorías - Lorteg',
      content: 'Taladros, tornillos...',
    })
    expect(res.status).toBe(200)
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: 'AIzaKey', embeddingsProvider: 'gemini' },
      'doc-new',
      'Productos y categorías - Lorteg',
      'Taladros, tornillos...',
    )
  })

  it('persists the raw title/content — trimmed, but never prefixed', async () => {
    await postKnowledge({ title: '  My Title  ', content: '  My content.  ' })
    expect(insertedDocs[0]).toMatchObject({ title: 'My Title', content: 'My content.' })
  })

  it('400s when title or content is missing', async () => {
    const res = await postKnowledge({ title: '', content: 'x' })
    expect(res.status).toBe(400)
    expect(ingestDocument).not.toHaveBeenCalled()
  })
})
