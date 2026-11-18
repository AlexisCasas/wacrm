import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Static guarantees of the PR-04 migrations (the behaviour is proven by supabase/ci/order-logistics-test.sql and storage.qa.test.ts against a real
// database): purely additive, SELECT-only browser access, service-role-only writers, private bucket without browser policies.

const dir = resolve(process.cwd(), 'supabase/migrations')
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n')
const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '')

const MODEL = '20261129000000_order_logistics_model.sql'
const SECURITY = '20261129000001_order_logistics_security_rpcs.sql'
const STORAGE = '20261129000002_order_docs_storage.sql'
const EVIDENCE = '20261129000003_order_evidence_rpc.sql'
const TABLES = ['order_logistics_settings', 'order_documents', 'order_template_dispatches', 'order_logistics', 'order_logistics_events']
const RPCS = [
  'register_order_document',
  'begin_document_ocr',
  'complete_document_ocr',
  'fail_document_ocr',
  'associate_order_document',
  'review_order_document',
  'start_order_packaging',
]

describe('PR-04 migrations · ordering and additivity', () => {
  it('sort after the PR-03 migration and are contiguous at the end', () => {
    const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const base = all.indexOf('20261128000000_conversation_routing.sql')
    expect(base).toBeGreaterThanOrEqual(0)
    expect(all.slice(base + 1, base + 5)).toEqual([MODEL, SECURITY, STORAGE, EVIDENCE])
  })

  it('never ALTER or DROP an existing object (only ENABLE ROW LEVEL SECURITY / OWNER on the new ones)', () => {
    for (const name of [MODEL, SECURITY, STORAGE, EVIDENCE]) {
      const code = strip(read(name))
      expect(code, name).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|CONSTRAINT|TYPE|POLICY\s+IF\s+EXISTS\s+(?!order_))/i)
      for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?(\w+)\s+([A-Z ]+)/gi)) {
        expect(TABLES, `${name}: ALTER TABLE on ${m[1]}`).toContain(m[1])
        expect(m[2].trim().toUpperCase(), name).toMatch(/^ENABLE ROW LEVEL SECURITY/)
      }
      expect(code, name).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(create_order_confirmation|conversation_operational_access|apply_order_confirmed_routing|derive_conversation_to_commercial)/)
      expect(code, name).not.toMatch(/ON\s+(public\.)?(order_confirmations|order_confirmation_items|conversations|messages|conversation_routing)\b[^;]*\bTRIGGER|CREATE TRIGGER[^;]*ON\s+(public\.)?(order_confirmations|order_confirmation_items|conversations|messages|conversation_routing)\b/i)
    }
  })

  it('does not activate any account, create settings rows or hardcode a template', () => {
    for (const name of [MODEL, SECURITY, STORAGE, EVIDENCE]) {
      const code = strip(read(name))
      expect(code, name).not.toMatch(/logistics_mvp_enabled\s*=\s*(TRUE|true)/)
      expect(code, name).not.toMatch(/INSERT\s+INTO\s+(public\.)?(order_integration_settings|order_logistics_settings)/i)
      expect(code, name).not.toMatch(/packaging_template_name\s*=\s*'/)
    }
  })
})

describe(`${MODEL}`, () => {
  const code = strip(read(MODEL))

  it.each(TABLES)('%s: RLS enabled, no browser privilege except SELECT (granted in the next migration)', (table) => {
    expect(code).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(`))
    expect(code).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`))
    expect(code).toMatch(/REVOKE ALL ON [^;]*FROM PUBLIC, anon, authenticated/)
    expect(code).not.toMatch(/GRANT [^;]*TO[^;]*\b(anon|authenticated)\b/)
  })

  it('every order-scoped table has the composite (order_id, account_id) FK to the order', () => {
    for (const t of ['order_documents', 'order_template_dispatches', 'order_logistics', 'order_logistics_events']) {
      expect(code).toMatch(new RegExp(`CONSTRAINT ${t}_order_fk FOREIGN KEY \\(order_id, account_id\\) REFERENCES public\\.order_confirmations \\(id, account_id\\) ON DELETE CASCADE`))
    }
  })

  it('visible logistic status is exactly the four approved ones; no extra visible status', () => {
    expect(code).toMatch(/CHECK \(status IN \('pending_voucher', 'voucher_validated', 'packing', 'ready_for_dispatch'\)\)/)
    for (const forbidden of ['processing', 'pending_association', 'template_sending', 'processed', 'en_origen', 'en_transito', 'entregado', 'pagado']) {
      expect(code).not.toMatch(new RegExp(`order_logistics_status_check[^;]*${forbidden}`))
    }
  })

  it('dispatches are an operational mutable table with ONE open dispatch per order; events stay append-only', () => {
    expect(code).toMatch(/CHECK \(status IN \('claimed', 'sending', 'sent', 'failed', 'uncertain'\)\)/)
    expect(code).toMatch(/order_template_dispatches_one_open[\s\S]*?WHERE status IN \('claimed', 'sending', 'uncertain'\)/)
    expect(code).toMatch(/order_logistics_events is append-only/)
  })

  it('documents: one validated voucher and one active evidence per order, frozen once validated, never hard-deleted', () => {
    expect(code).toMatch(/order_documents_one_validated_voucher[\s\S]*?WHERE kind = 'voucher' AND status = 'validated'/)
    expect(code).toMatch(/order_documents_one_active_evidence[\s\S]*?WHERE kind = 'evidence' AND status = 'active'/)
    expect(code).toMatch(/a validated, rejected or superseded document is frozen/)
    expect(code).toMatch(/order_documents_delete_guard/)
    expect(code).toMatch(/storage_bucket = 'order-docs'/)
  })

  it('does not touch order_confirmations.delivery_status nor the financial / tracking axes', () => {
    expect(code).not.toMatch(/delivery_status/)
    expect(code).not.toMatch(/\b(saldo|cobranza|payment|shalom|tracking)\b/i)
  })
})

describe(`${SECURITY}`, () => {
  const code = strip(read(SECURITY))

  it('browser roles only get SELECT, through policies driven by the access helper; no write policy exists', () => {
    expect(code).toMatch(/GRANT SELECT ON [^;]*TO authenticated/)
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i)
    for (const t of TABLES) expect(code).toMatch(new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT USING \\(public\\.order_logistics_access\\(account_id\\)\\)`))
  })

  it('the access helper needs flag ON + logistics/supervisor + agent+ and never consults conversation_routing', () => {
    expect(code).toMatch(/s\.logistics_mvp_enabled/)
    expect(code).toMatch(/p\.operational_role IN \('logistics', 'supervisor'\)/)
    expect(code).toMatch(/p\.account_role IN \('owner', 'admin', 'agent'\)/)
    expect(code).not.toMatch(/conversation_routing/)
  })

  it.each(RPCS)('%s is SECURITY DEFINER, pins search_path and is executable only by service_role', (rpc) => {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${rpc}(`)
    expect(start, rpc).toBeGreaterThanOrEqual(0)
    const head = code.slice(start, code.indexOf('AS $$', start))
    expect(head).toMatch(/SECURITY DEFINER/)
    expect(head).toMatch(/SET search_path = public/)
    expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
    expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO service_role;`))
    expect(code).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO[^;]*(authenticated|anon|PUBLIC)`))
  })

  it('every RPC re-validates the actor in the database before doing anything', () => {
    for (const rpc of RPCS) {
      const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${rpc}(`)
      const body = code.slice(start, code.indexOf('$$;', start))
      expect(body, rpc).toMatch(/public\.order_logistics_actor\(p_account, p_actor\)/)
    }
  })
})

describe(`${STORAGE}`, () => {
  const mig = read(STORAGE)
  const code = strip(mig)

  it('creates a PRIVATE bucket named order-docs with an allow-list and a size limit, and never makes it public', () => {
    expect(code).toMatch(/'order-docs',\s*'order-docs',\s*FALSE,/)
    expect(code).toMatch(/public = FALSE/)
    expect(code).not.toMatch(/public\s*=\s*TRUE/i)
    expect(code).toMatch(/ARRAY\['application\/pdf', 'image\/jpeg', 'image\/png', 'image\/webp'\]/)
  })

  it('creates NO policy on storage.objects (server-only access) and touches no other bucket', () => {
    expect(code).not.toMatch(/CREATE POLICY/i)
    expect(code).not.toMatch(/chat-media|flow-media|voice-notes|avatars/)
  })
})

describe(`${EVIDENCE}`, () => {
  const code = strip(read(EVIDENCE))

  it('is one SECURITY DEFINER function, executable only by service_role, that re-validates the actor and the order', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.select_order_evidence\(/)
    expect(code).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
    expect(code).toMatch(/public\.order_logistics_actor\(p_account, p_actor\)/)
    expect(code).toMatch(/public\.order_logistics_require_order\(p_account, p_order\)/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.select_order_evidence\([^)]*\) FROM PUBLIC, anon, authenticated;/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.select_order_evidence\([^)]*\) TO service_role;/)
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*(authenticated|anon|PUBLIC)/)
  })

  it('only while packing, only a message of the order conversation, and never while a dispatch is open', () => {
    expect(code).toMatch(/'not_packing'/)
    expect(code).toMatch(/message_not_in_conversation/)
    expect(code).toMatch(/c\.id = v_conversation AND c\.account_id = p_account/)
    expect(code).toMatch(/'dispatch_open'/)
  })

  it('creates nothing else: no table, policy, bucket or trigger, and it does not touch messages / chat-media', () => {
    expect(code).not.toMatch(/CREATE TABLE|CREATE POLICY|CREATE TRIGGER|storage\.buckets|chat-media/i)
    expect(code).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+(public\.)?(messages|conversations|conversation_routing)/i)
  })
})
