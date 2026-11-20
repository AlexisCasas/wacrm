import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261205000001_shipment_arrival_message.sql')
const code = mig.replace(/^--.*$/gm, '')
const fnBody = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.order_shipments_arrival_message()'), code.indexOf('ALTER FUNCTION public.order_shipments_arrival_message()'))

describe('20261205000001_shipment_arrival_message', () => {
  it('is additive and idempotent: no DROP of tables / columns / data, no DELETE, no data writes outside the new ledger rows', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|FUNCTION)\b/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i)
    expect(code).not.toMatch(/\bUPDATE\s+public\./i)
    expect(code.match(/\bINSERT\s+INTO\s+[\w.]+/gi)).toEqual(['INSERT INTO public.order_shipment_messages'])
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS arrival_message_template_name/)
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/)
  })

  it('activates nothing: no flag is set to TRUE and no existing setting is written', () => {
    expect(code).not.toMatch(/(destination_customer_message_enabled|shalom_tracking_enabled|logistics_mvp_enabled|order_payments_enabled)\s*=\s*(TRUE|true)\s*[,;)]?\s*$/m)
    expect(code).not.toMatch(/\bUPDATE\s+(public\.)?\w+\s+SET\b/i)
  })

  it('adds the arrival kind next to the day-15 one and keeps every event type that already existed', () => {
    expect(code).toMatch(/kind IN \('destination_15d_customer', 'destination_arrival_customer'\)/)
    for (const t of ['shipment_registered', 'status_changed', 'delivered', 'pickup_abandoned', 'destination_customer_message_due', 'destination_customer_message_sent', 'destination_customer_message_failed', 'destination_customer_message_uncertain', 'destination_customer_message_skipped', 'destination_customer_message_retry_requested'])
      expect(code).toContain(`'${t}'`)
    expect(code).toContain("'destination_arrival_message_due'")
  })

  it('the trigger fires only on the transition INTO at_destination, after the update, and only creates a row when every switch and the template are configured', () => {
    expect(code).toMatch(/AFTER UPDATE ON public\.order_shipments\s+FOR EACH ROW WHEN \(NEW\.logistic_status = 'at_destination' AND OLD\.logistic_status IS DISTINCT FROM 'at_destination'\)/)
    expect(fnBody).toMatch(/logistics_mvp_enabled/)
    expect(fnBody).toMatch(/s\.shalom_tracking_enabled AND s\.destination_customer_message_enabled/)
    expect(fnBody).toMatch(/IF NOT FOUND OR st\.tname IS NULL OR st\.tlang IS NULL THEN RETURN NULL; END IF;/)
    expect(fnBody.indexOf('RETURN NULL')).toBeLessThan(fnBody.indexOf('INSERT INTO public.order_shipment_messages'))
  })

  it('is idempotent per episode: ON CONFLICT on the unique (order, episode, kind) and one due event per episode', () => {
    expect(fnBody).toMatch(/ON CONFLICT \(order_id, destination_episode, kind\) DO NOTHING/)
    expect(code).toMatch(/order_shipment_events_arrival_due_once[\s\S]*event_type = 'destination_arrival_message_due'/)
  })

  it('is internal: the trigger function is not callable by any API role, takes no actor and never touches the Shalom status, the tracking or the order', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.order_shipments_arrival_message\(\) FROM PUBLIC, anon, authenticated, service_role/)
    expect(fnBody).not.toMatch(/auth\.uid\(\)|p_actor/)
    expect(fnBody).not.toMatch(/UPDATE\s+public\.(order_shipments|order_confirmations)/i)
  })

  it('does not replace the shared sender RPCs (claim / mark sending / finish / retry / resolve): same retry, uncertain and skip policy', () => {
    expect(code).not.toMatch(/FUNCTION public\.(claim_shipment_messages|mark_shipment_message_sending|finish_shipment_message|retry_shipment_message|resolve_shipment_message)/)
  })
})
