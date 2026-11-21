import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mig = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261205000004_balance_trusted_since.sql'), 'utf8').replace(/\r\n/g, '\n')
const code = mig.replace(/^--.*$/gm, '')

describe('20261205000004_balance_trusted_since', () => {
  it('is one nullable column: additive, idempotent, no data change, no default that would turn it ON', () => {
    expect(code.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(1)
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS balance_trusted_since TIMESTAMPTZ;/)
    expect(code).not.toMatch(/NOT NULL|DEFAULT/i)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+(public\.)?\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN))\b/i)
  })

  it('does not touch orders, payments or any flag', () => {
    expect(code).not.toMatch(/order_confirmations|order_payments\b|order_financials|enabled\s*=/i)
  })
})
