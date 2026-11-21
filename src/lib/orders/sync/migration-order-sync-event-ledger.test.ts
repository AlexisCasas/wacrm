import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const MIGRATION = '20261205000006_order_sync_event_ledger.sql'
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('SYNC-02 event ledger migration', () => {
  it('is additive and never touches an existing business table or installs business triggers', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.order_sync_events/)
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.order_sync_receipts/)
    expect(code).not.toMatch(/ALTER TABLE public\.(order_confirmations|order_payments|order_documents|order_logistics|order_shipments|messages)\b/i)
    expect(code).not.toMatch(/CREATE TRIGGER[^;]*ON public\.(order_confirmations|order_payments|order_documents|order_logistics|order_shipments|messages)\b/i)
    expect(code).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(order_confirmations|order_payments|order_documents|order_logistics|order_shipments|messages)\b/i)
  })

  it('keeps the WACRM UUID as the only order identity and has no InkaClick legacy-id column', () => {
    expect(code).toMatch(/canonical_order_id UUID NOT NULL/)
    expect(code).not.toMatch(/inkaclick_order_id|legacy_inkaclick_id|confirmed_order_id/)
  })

  it('makes events append-only and idempotent on origin event plus origin key', () => {
    expect(code).toMatch(/order_sync_events is append-only/)
    expect(code).toMatch(/UNIQUE \(origin_system, origin_event_id\)/)
    expect(code).toMatch(/UNIQUE \(origin_system, idempotency_key\)/)
    expect(code).toMatch(/sync_event_identity_conflict/)
  })

  it('prevents event bounce by exposing only locally-originated outbound events', () => {
    expect(code).toMatch(/CREATE OR REPLACE VIEW public\.order_sync_outbound_events/)
    expect(code).toMatch(/WHERE e\.origin_system = 'wacrm'/)
  })

  it('does not expose browser writes and only service_role can execute writer RPCs', () => {
    expect(code).toMatch(/REVOKE ALL ON public\.order_sync_events, public\.order_sync_receipts FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT SELECT ON public\.order_sync_events, public\.order_sync_receipts, public\.order_sync_outbound_events TO service_role/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.record_order_sync_event\([\s\S]*?FROM PUBLIC, anon, authenticated;/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_order_sync_event\([\s\S]*?TO service_role;/)
  })

  it('does not implement transport or domain synchronization yet', () => {
    expect(code).not.toMatch(/http|net\.|pg_net|webhook|cron|whatsapp|shalom_api|payment_registered|voucher_validated/i)
  })
})
