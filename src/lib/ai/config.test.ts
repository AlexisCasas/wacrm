import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig, loadEmbeddingsKey } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig — embeddingsProvider derivation', () => {
  it('provider=gemini + embeddings key → embeddingsProvider="gemini"', async () => {
    const row = { ...ROW, provider: 'gemini', embeddings_api_key: 'enc-embed-key' }
    const config = await loadAiConfig(dbReturning(row), 'acct', { requireActive: false })
    expect(config!.embeddingsProvider).toBe('gemini')
  })

  it('provider=openai + embeddings key → embeddingsProvider="openai"', async () => {
    const row = { ...ROW, provider: 'openai', embeddings_api_key: 'enc-embed-key' }
    const config = await loadAiConfig(dbReturning(row), 'acct', { requireActive: false })
    expect(config!.embeddingsProvider).toBe('openai')
  })

  it('provider=anthropic + embeddings key → embeddingsProvider="openai" (Anthropic has no embeddings endpoint)', async () => {
    const row = { ...ROW, provider: 'anthropic', embeddings_api_key: 'enc-embed-key' }
    const config = await loadAiConfig(dbReturning(row), 'acct', { requireActive: false })
    expect(config!.embeddingsProvider).toBe('openai')
  })

  it('no embeddings key → embeddingsProvider=null, regardless of chat provider', async () => {
    const geminiRow = { ...ROW, provider: 'gemini', embeddings_api_key: null }
    const config = await loadAiConfig(dbReturning(geminiRow), 'acct', { requireActive: false })
    expect(config!.embeddingsProvider).toBeNull()
  })
})

describe('loadEmbeddingsKey — provider derivation', () => {
  function dbReturningEmbeddings(row: Record<string, unknown> | null): SupabaseClient {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
    }
    return chain as unknown as SupabaseClient
  }

  it('gemini chat provider + key → provider="gemini"', async () => {
    const result = await loadEmbeddingsKey(
      dbReturningEmbeddings({ provider: 'gemini', embeddings_api_key: 'enc-key' }),
      'acct',
    )
    expect(result).toEqual({ key: 'plain:enc-key', corrupt: false, provider: 'gemini' })
  })

  it('openai chat provider + key → provider="openai"', async () => {
    const result = await loadEmbeddingsKey(
      dbReturningEmbeddings({ provider: 'openai', embeddings_api_key: 'enc-key' }),
      'acct',
    )
    expect(result.provider).toBe('openai')
  })

  it('anthropic chat provider + key → provider="openai"', async () => {
    const result = await loadEmbeddingsKey(
      dbReturningEmbeddings({ provider: 'anthropic', embeddings_api_key: 'enc-key' }),
      'acct',
    )
    expect(result.provider).toBe('openai')
  })

  it('no key at all → key=null, provider=null', async () => {
    const result = await loadEmbeddingsKey(
      dbReturningEmbeddings({ provider: 'gemini', embeddings_api_key: null }),
      'acct',
    )
    expect(result).toEqual({ key: null, corrupt: false, provider: null })
  })

  it('no row at all → key=null, provider=null', async () => {
    const result = await loadEmbeddingsKey(dbReturningEmbeddings(null), 'acct')
    expect(result).toEqual({ key: null, corrupt: false, provider: null })
  })
})
