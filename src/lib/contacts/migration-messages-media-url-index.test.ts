import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261119000001_messages_media_url_index.sql'), 'utf8')
const code = sql.replace(/^--.*$/gm, '').trim()

describe('migration 20261119000001 — messages.media_url index for media cleanup', () => {
  it('creates exactly one partial index on messages(media_url)', () => {
    expect(code).toBe('CREATE INDEX IF NOT EXISTS idx_messages_media_url ON public.messages (media_url) WHERE media_url IS NOT NULL;')
  })

  it('uses only IS NOT NULL (an equality join key implies it; <> \'\' would make the index unusable for the cleanup probe)', () => {
    expect(code).not.toContain("<> ''")
  })

  it('is index-only: no data, function, grant or timeout change and no blocking/uniqueness structure', () => {
    expect(code).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|DROP|ALTER|GRANT|REVOKE|TRUNCATE|FUNCTION|TRIGGER|POLICY|UNIQUE)\b|statement_timeout|tombstone|blacklist|blocked/i)
  })
})
