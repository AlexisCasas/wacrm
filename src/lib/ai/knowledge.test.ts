import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument, extractKeywords } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  /** Result for the strict full-query FTS search (the default response
   *  for any term not overridden in `ftsByTerm`). */
  fts: { id: string; content: string }[]
  /** Per-keyword override for the fallback's individual RPC calls —
   *  keyed by the exact `p_query` term sent. */
  ftsByTerm: Record<string, { id: string; content: string }[]>
  /** Terms that should make the RPC call reject (simulates an RPC
   *  error for the keyword-fallback path). */
  ftsRejectTerms: Set<string>
  chunkCount: number
  rpcCalls: { name: string; query?: string }[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    ftsByTerm: {},
    ftsRejectTerms: new Set(),
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    inserted: null,
    deletedFor: null,
  }
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      const query = args?.p_query as string | undefined
      state.rpcCalls.push({ name, query })
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts') {
        if (query !== undefined && state.ftsRejectTerms.has(query)) {
          return Promise.reject(new Error(`RPC failed for term "${query}"`))
        }
        if (query !== undefined && query in state.ftsByTerm) {
          return Promise.resolve({ data: state.ftsByTerm[query], error: null })
        }
        return Promise.resolve({ data: state.fts, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => Promise.resolve({ count: state.chunkCount, error: null }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          state.deletedFor = val
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

const OPENAI_CFG = { embeddingsApiKey: 'sk-x', embeddingsProvider: 'openai' as const }
const NO_KEY_CFG = { embeddingsApiKey: null, embeddingsProvider: null }

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_provider: string, _key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge — existing behavior (unchanged)', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', NO_KEY_CFG, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', OPENAI_CFG, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls.map((c) => c.name)).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present, passing the provider through', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', OPENAI_CFG, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledWith('openai', 'sk-x', ['q'], { kind: 'query' })
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls.map((c) => c.name)).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', OPENAI_CFG, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls.map((c) => c.name)).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('extractKeywords', () => {
  it('strips punctuation and lowercases', () => {
    expect(extractKeywords('¿Tienen Taladros?')).toEqual(['tienen', 'taladros'])
  })

  it('drops common Spanish/English stopwords', () => {
    const kw = extractKeywords('Hola, ¿qué productos venden?')
    expect(kw).not.toContain('hola')
    expect(kw).not.toContain('qué')
    expect(kw).not.toContain('que')
    expect(kw).toContain('productos')
    expect(kw).toContain('venden')
  })

  it('drops very short tokens', () => {
    expect(extractKeywords('a de un mi tu')).toEqual([])
  })

  it('handles Unicode/accented tokens correctly', () => {
    expect(extractKeywords('¿Dónde está la ubicación?')).toContain('ubicación')
  })

  it('deduplicates repeated terms', () => {
    expect(extractKeywords('productos productos productos')).toEqual(['productos'])
  })

  it('caps the number of extracted keywords', () => {
    const longQuery = Array.from({ length: 20 }, (_, i) => `keyword${i}`).join(' ')
    expect(extractKeywords(longQuery).length).toBeLessThanOrEqual(6)
  })

  it('returns [] for an all-stopword / all-punctuation query', () => {
    expect(extractKeywords('¿Y o?')).toEqual([])
  })
})

describe('retrieveKnowledge — lexical keyword fallback (issue: 0 matches on natural questions)', () => {
  it('"¿Tienen taladros?" finds the chunk via the "taladros" keyword when the strict AND-query finds nothing', async () => {
    const { db, state } = makeDb()
    state.fts = [] // strict full-sentence query: 0 results
    state.ftsByTerm['taladros'] = [{ id: 'c1', content: 'Taladros disponibles en stock.' }]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, '¿Tienen taladros?')
    expect(out).toEqual(['Taladros disponibles en stock.'])
  })

  it('"Hola, ¿qué productos venden?" finds the chunk via the "productos" keyword', async () => {
    const { db, state } = makeDb()
    state.fts = []
    state.ftsByTerm['productos'] = [
      { id: 'c2', content: 'Productos y categorías - Lorteg.' },
    ]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'Hola, ¿qué productos venden?')
    expect(out).toEqual(['Productos y categorías - Lorteg.'])
  })

  it('"¿Hacen envíos fuera de Lima?" finds chunks via "envíos"/"lima" keywords', async () => {
    const { db, state } = makeDb()
    state.fts = []
    state.ftsByTerm['envíos'] = [{ id: 'c3', content: 'Hacemos envíos a todo el Perú.' }]
    state.ftsByTerm['lima'] = [{ id: 'c4', content: 'Ubicados en Lima, Perú.' }]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, '¿Hacen envíos fuera de Lima?', 5)
    expect(out).toContain('Hacemos envíos a todo el Perú.')
    expect(out).toContain('Ubicados en Lima, Perú.')
  })

  // "¿Dónde están ubicados?" is NOT a case the keyword fallback can be
  // trusted to solve: "ubicados" and "ubicación" are different word
  // forms, and FTS `'simple'` config does no stemming/lemmatization —
  // Postgres will NOT match one against the other. Asserting otherwise
  // would simulate behavior real Postgres doesn't have. This is
  // precisely the gap semantic search exists to cover (below).
  it('lexical-only: "¿Dónde están ubicados?" may legitimately return [] — "ubicados" ≠ "ubicación" under FTS \'simple\' (no stemming)', async () => {
    const { db, state } = makeDb()
    state.fts = []
    // Deliberately NOT overriding ftsByTerm['ubicados'] — the realistic
    // simulation is that this term matches nothing, because the KB chunk
    // contains "ubicación", a different literal token.

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, '¿Dónde están ubicados?')
    expect(out).toEqual([])
  })

  it('semantic retrieval (Gemini) resolves "¿Dónde están ubicados?" via match_ai_knowledge_semantic, independent of exact wording', async () => {
    const { db, state } = makeDb()
    // The semantic RPC mock does no text matching at all — it's a pure
    // stand-in for pgvector's cosine-distance ORDER BY, exactly like the
    // real RPC would return for a paraphrase whose embedding happens to
    // land near the "Contacto y ubicación" chunk's.
    state.semantic = [{ id: 'c5', content: 'Contacto y ubicación - Lorteg.' }]
    const geminiCfg = { embeddingsApiKey: 'AIzaKey', embeddingsProvider: 'gemini' as const }

    const out = await retrieveKnowledge(db, 'acct', geminiCfg, '¿Dónde están ubicados?')

    expect(out).toEqual(['Contacto y ubicación - Lorteg.'])
    expect(h.embedTexts).toHaveBeenCalledWith('gemini', 'AIzaKey', ['¿Dónde están ubicados?'], {
      kind: 'query',
    })
  })

  it('a strict query that already matches does NOT trigger the keyword fallback', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'c1', content: 'Direct strict match.' }]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'taladros')
    expect(out).toEqual(['Direct strict match.'])
    // Only the one strict call — no per-keyword fan-out.
    expect(state.rpcCalls).toHaveLength(1)
  })

  it('deduplicates chunks matched by more than one fallback keyword', async () => {
    const { db, state } = makeDb()
    state.fts = []
    const sharedChunk = { id: 'c1', content: 'Productos y envíos en un mismo párrafo.' }
    state.ftsByTerm['productos'] = [sharedChunk]
    state.ftsByTerm['envíos'] = [sharedChunk]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, '¿productos y envíos?', 5)
    expect(out).toEqual(['Productos y envíos en un mismo párrafo.'])
  })

  it('caps fallback results at k across multiple keywords', async () => {
    const { db, state } = makeDb()
    state.fts = []
    state.ftsByTerm['productos'] = [
      { id: 'c1', content: 'P1' },
      { id: 'c2', content: 'P2' },
    ]
    state.ftsByTerm['envíos'] = [
      { id: 'c3', content: 'E1' },
      { id: 'c4', content: 'E2' },
    ]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'productos y envíos', 2)
    expect(out).toHaveLength(2)
  })

  it('passes k as p_match_count on every fallback RPC call', async () => {
    const { db, state } = makeDb()
    state.fts = []
    await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'productos y envíos', 3)
    const ftsCalls = state.rpcCalls.filter((c) => c.name === 'match_ai_knowledge_fts')
    expect(ftsCalls.length).toBeGreaterThan(1) // strict + at least one keyword
  })

  it('a rejected per-keyword RPC call degrades gracefully (best-effort) without losing other keywords\' results', async () => {
    const { db, state } = makeDb()
    state.fts = []
    state.ftsRejectTerms.add('productos')
    state.ftsByTerm['envíos'] = [{ id: 'c1', content: 'Envíos disponibles.' }]

    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'productos y envíos', 5)
    expect(out).toEqual(['Envíos disponibles.'])
  })

  it('a query with no extractable keywords (all stopwords) skips the fallback without error', async () => {
    const { db, state } = makeDb()
    state.fts = []
    const out = await retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'y o de la', 5)
    expect(out).toEqual([])
    // Only the one strict call — extractKeywords returned [], no fan-out.
    expect(state.rpcCalls).toHaveLength(1)
  })

  it('an error on the strict lexical RPC still degrades to [] rather than throwing', async () => {
    const db = {
      rpc: () => Promise.reject(new Error('db unreachable')),
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ count: 5, error: null }) }),
      }),
    } as unknown as SupabaseClient
    await expect(retrieveKnowledge(db, 'acct', NO_KEY_CFG, 'productos')).resolves.toEqual([])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks with the configured provider when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', OPENAI_CFG, 'doc-1', 'Some Title', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledWith('openai', 'sk-x', ['hello world'], {
      kind: 'document',
      title: 'Some Title',
    })
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
    // The persisted content is the raw chunk — never the Gemini-only prefix.
    expect(state.inserted![0].content).toBe('hello world')
  })

  it('embeds chunks with Gemini when embeddingsProvider is "gemini", passing the document title through', async () => {
    const { db } = makeDb()
    const geminiCfg = { embeddingsApiKey: 'AIzaGeminiKey', embeddingsProvider: 'gemini' as const }
    await ingestDocument(db, 'acct', geminiCfg, 'doc-1', 'Contacto y ubicación - Lorteg', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledWith('gemini', 'AIzaGeminiKey', ['hello world'], {
      kind: 'document',
      title: 'Contacto y ubicación - Lorteg',
    })
  })

  it('passes title: null through untouched when the document has no title', async () => {
    const { db } = makeDb()
    const geminiCfg = { embeddingsApiKey: 'AIzaGeminiKey', embeddingsProvider: 'gemini' as const }
    await ingestDocument(db, 'acct', geminiCfg, 'doc-1', null, 'hello world')
    expect(h.embedTexts).toHaveBeenCalledWith('gemini', 'AIzaGeminiKey', ['hello world'], {
      kind: 'document',
      title: null,
    })
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', NO_KEY_CFG, 'doc-1', 'Some Title', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', OPENAI_CFG, 'doc-1', 'Some Title', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', OPENAI_CFG, 'doc-1', 'Some Title', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })
})
