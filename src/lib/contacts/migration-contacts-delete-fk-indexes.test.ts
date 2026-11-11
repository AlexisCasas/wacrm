import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261119000000_contacts_delete_fk_indexes.sql'), 'utf8')
const code = sql.replace(/^--.*$/gm, '')

describe('migration 20261119000000 — indexes for contact-delete foreign keys', () => {
  it('indexes exactly the unindexed referencing columns that made 100-contact batches exceed statement_timeout', () => {
    for (const [table, column] of [
      ['whatsapp_message_pricing', 'conversation_id'],
      ['flow_runs', 'conversation_id'],
      ['flow_runs', 'contact_id'],
      ['automation_logs', 'contact_id'],
      ['automation_pending_executions', 'contact_id'],
    ]) {
      expect(code).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS \\w+ ON public\\.${table} \\(${column}\\) WHERE ${column} IS NOT NULL;`))
    }
    expect(code.match(/CREATE INDEX/g)).toHaveLength(5)
  })

  it('is index-only: no data change, function change, grant or timeout change (delete semantics and re-creation unchanged)', () => {
    expect(code).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|DROP|ALTER|GRANT|REVOKE|TRUNCATE)\b|statement_timeout|FUNCTION|TRIGGER/i)
    expect(code).not.toMatch(/CONCURRENTLY/i) // migrations run inside a transaction; the tables are small
  })

  it('does not add any uniqueness/blocklist that could stop a deleted phone from coming back', () => {
    expect(code).not.toMatch(/UNIQUE|tombstone|blacklist|blocked/i)
  })
})
