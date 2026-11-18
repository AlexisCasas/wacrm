import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// FIX 03 migration guard: it must stay additive, idempotent and data-neutral.
const sql = readFileSync('supabase/migrations/20261126000000_contacts_name_locked.sql', 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('20261126000000_contacts_name_locked.sql', () => {
  it('adds exactly one NOT NULL boolean column defaulting to false, idempotently', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS name_locked boolean NOT NULL DEFAULT false/i)
    expect((code.match(/ADD COLUMN/gi) ?? []).length).toBe(1)
  })
  it('does not rewrite, delete or backfill data, and changes no policy, grant, trigger or index', () => {
    for (const forbidden of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bINSERT\b/i, /\bPOLICY\b/i, /\bGRANT\b/i, /\bREVOKE\b/i, /\bTRIGGER\b/i, /\bINDEX\b/i, /\bALTER\s+POLICY\b/i]) {
      expect(code).not.toMatch(forbidden)
    }
  })
})
