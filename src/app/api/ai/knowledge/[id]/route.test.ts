import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// PATCH /api/ai/knowledge/[id] — confirms re-indexing after a content-only
// edit uses the document's CURRENT (stored) title, and that editing both
// title + content uses the NEW title — Gemini's asymmetric document format
// needs the right title either way.
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acct-1'
const USER_ID = 'user-1'
const DOC_ID = 'doc-1'

let callerRole = 'admin'
/** The title PATCH's update+select returns — simulates the DB's current
 *  stored value after applying whatever this request's `update` touched. */
let resultingTitle = 'Stored Title'
const updateCalls: Record<string, unknown>[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    const resolveResult = () => {
      if (table === 'profiles') {
        return { data: { account_id: ACCOUNT_ID, account_role: callerRole }, error: null }
      }
      if (table === 'accounts') {
        return { data: { id: ACCOUNT_ID, name: 'Acme' }, error: null }
      }
      if (table === 'ai_knowledge_documents') {
        return { data: { id: DOC_ID, title: resultingTitle }, error: null }
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(resolveResult()))
    b.update = vi.fn((row: Record<string, unknown>) => {
      updateCalls.push(row)
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
  loadEmbeddingsKey: vi.fn(async () => ({
    key: null as string | null,
    corrupt: false,
    provider: null as 'openai' | 'gemini' | null,
  })),
}))
vi.mock('@/lib/ai/config', () => ({ loadEmbeddingsKey }))

const { ingestDocument } = vi.hoisted(() => ({
  ingestDocument: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument }))

import { PATCH } from './route'

function patchDoc(body: Record<string, unknown>) {
  return PATCH(
    new Request('http://localhost/api/ai/knowledge/doc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: DOC_ID }) },
  )
}

beforeEach(() => {
  callerRole = 'admin'
  resultingTitle = 'Stored Title'
  updateCalls.length = 0
  supabaseMock = makeSupabaseMock()
  loadEmbeddingsKey.mockClear()
  loadEmbeddingsKey.mockResolvedValue({ key: null, corrupt: false, provider: null })
  ingestDocument.mockClear()
  ingestDocument.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PATCH /api/ai/knowledge/[id]', () => {
  it('a content-only edit re-ingests using the CURRENT stored title (not undefined)', async () => {
    resultingTitle = 'Contacto y ubicación - Lorteg' // simulates the row's existing title
    const res = await patchDoc({ content: 'Updated content.' })

    expect(res.status).toBe(200)
    // The update payload itself must NOT include title — this request never touched it.
    expect(updateCalls[0]).not.toHaveProperty('title')
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: null, embeddingsProvider: null },
      DOC_ID,
      'Contacto y ubicación - Lorteg',
      'Updated content.',
    )
  })

  it('editing both title and content re-ingests using the NEW title', async () => {
    resultingTitle = 'New Title' // the row after this PATCH's update is applied
    const res = await patchDoc({ title: 'New Title', content: 'Updated content.' })

    expect(res.status).toBe(200)
    expect(updateCalls[0]).toMatchObject({ title: 'New Title' })
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: null, embeddingsProvider: null },
      DOC_ID,
      'New Title',
      'Updated content.',
    )
  })

  it('a title-only edit (no content) does NOT re-ingest at all', async () => {
    resultingTitle = 'Just A New Title'
    const res = await patchDoc({ title: 'Just A New Title' })

    expect(res.status).toBe(200)
    expect(ingestDocument).not.toHaveBeenCalled()
  })

  it('passes the Gemini provider through on a content edit, with the current title', async () => {
    loadEmbeddingsKey.mockResolvedValue({
      key: 'AIzaKey',
      corrupt: false,
      provider: 'gemini',
    })
    resultingTitle = 'Productos y categorías - Lorteg'

    await patchDoc({ content: 'Taladros disponibles.' })

    expect(ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { embeddingsApiKey: 'AIzaKey', embeddingsProvider: 'gemini' },
      DOC_ID,
      'Productos y categorías - Lorteg',
      'Taladros disponibles.',
    )
  })
})
