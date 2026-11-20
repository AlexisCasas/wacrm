import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mig = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261205000002_balance_templates_and_payment_instructions.sql'), 'utf8').replace(/\r\n/g, '\n')
const code = mig.replace(/^--.*$/gm, '')

describe('20261205000002_balance_templates_and_payment_instructions', () => {
  it('is additive and idempotent: only new nullable columns and their constraints; no DROP of data, no writes, no flag, no template', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|FUNCTION|TRIGGER|POLICY)\b/i)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+(public\.)?\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i)
    expect(code).not.toMatch(/NOT NULL/i)
    expect(code.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(7)
    expect(code).not.toMatch(/(enabled)\s*=\s*(TRUE|true)/)
  })

  it('adds the balance variants next to the existing templates and the payment instructions to the payments settings', () => {
    for (const c of ['packaging_balance_template_name', 'packaging_balance_template_language', 'packaging_balance_template_params', 'arrival_balance_template_name', 'arrival_balance_template_language', 'arrival_balance_template_params', 'customer_payment_instructions'])
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${c}`)
  })

  it('the payment instructions are one short line: bounded, non blank, no control characters', () => {
    expect(code).toMatch(/char_length\(customer_payment_instructions\) <= 200/)
    expect(code).toMatch(/customer_payment_instructions !~ '\[\[:cntrl:\]\]'/)
  })

  it('does not hardcode any bank / payment value', () => {
    expect(mig).not.toMatch(/\b\d{9,}\b/)
    expect(mig).not.toMatch(/yape|plin|interbank|bbva/i)
  })
})
