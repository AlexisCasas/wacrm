import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mig = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261205000003_shipment_voucher_message.sql'), 'utf8').replace(/\r\n/g, '\n')
const code = mig.replace(/^--.*$/gm, '')

describe('20261205000003_shipment_voucher_message', () => {
  it('is additive: no DROP of data, no writes to existing rows, no flag activation, no template', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|FUNCTION)\b/i)
    // only idempotent re-creation of its own constraints / trigger / policy
    expect(code.match(/\bDROP\s+(CONSTRAINT|TRIGGER|POLICY)\b/gi)?.length).toBe(code.match(/\bDROP\s+(CONSTRAINT|TRIGGER|POLICY)\s+IF EXISTS\b/gi)?.length)
    expect(code).not.toMatch(/\b(INSERT\s+INTO\s+public\.(?!order_shipment_voucher_messages|order_shipment_events)|DELETE\s+FROM|TRUNCATE)\b/i)
    expect(code).not.toMatch(/(enabled)\s*=\s*(TRUE|true)/)
  })

  it('one notice per guide, own ledger with RLS, guard trigger and no direct delete', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.order_shipment_voucher_messages/)
    expect(code).toMatch(/UNIQUE\s*\(order_id, identifier_version\)/i)
    expect(code).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/CREATE TRIGGER order_shipment_voucher_messages_guard/)
  })

  it('every RPC is SECURITY DEFINER and reserved to the service role', () => {
    for (const f of ['begin_shipment_voucher_message', 'mark_shipment_voucher_sending', 'finish_shipment_voucher_message', 'retry_shipment_voucher_message', 'resolve_shipment_voucher_message']) {
      expect(code).toContain(`public.${f}(`)
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f}(`)
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO service_role`))
    }
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO (anon|authenticated)/i)
  })

  it('does not hardcode any payment / bank value', () => {
    expect(mig).not.toMatch(/\b\d{9,}\b/)
    expect(mig).not.toMatch(/yape|plin|interbank|bbva/i)
  })
})
