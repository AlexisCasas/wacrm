import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261119000003_flow_runs_last_prompt_message_index.sql'), 'utf8')
const code = sql.replace(/^--.*$/gm, '').trim()

describe('migration 20261119000003 — flow_runs.last_prompt_message_id index (message delete cascade)', () => {
  it('creates exactly one partial index on flow_runs(last_prompt_message_id), the FK to messages that was scanned once per deleted message', () => {
    expect(code).toBe('CREATE INDEX IF NOT EXISTS idx_flow_runs_last_prompt_message ON public.flow_runs (last_prompt_message_id) WHERE last_prompt_message_id IS NOT NULL;')
  })

  it('is index-only: no data, function, grant, policy or timeout change and nothing that could block a returning phone', () => {
    expect(code).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|DROP|ALTER|GRANT|REVOKE|TRUNCATE|FUNCTION|TRIGGER|POLICY|UNIQUE)\b|statement_timeout|tombstone|blacklist|blocked/i)
  })

  it('documents the measured cause (trigger time per message) so the index is not removed as unused', () => {
    expect(sql).toContain('flow_runs_last_prompt_message_id_fkey')
    expect(sql).toContain('ON DELETE SET NULL')
  })
})
