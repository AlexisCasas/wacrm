import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// PR-04 <-> PR-03 COMPATIBILITY. This test belongs to PR-04 and replaces nothing: the frozen PR-03 test (src/lib/orders/migration-conversation-routing.test.ts)
// is left byte-for-byte intact.
//
// EXPECTED HISTORICAL TEST FAILURE AFTER ADDITIVE MIGRATIONS
//   The frozen test asserts `all.indexOf('20261128000000_conversation_routing.sql') === all.length - 1` ("PR-03's migration is the LAST file"). That was true when
//   PR-03 closed and stops being true, legitimately, the moment ANY later additive migration exists. It is a historical invariant of PR-03, not a functional
//   check: its other 9 assertions pass, and the functional routing suites (supabase/ci/conversation-routing-test.sql, conversation-handoff-test.sql and
//   pr04-pr03-compat-test.sql) pass with the PR-04 migrations applied. The test below proves, with the same inputs, that the ONLY reason is the later files.
//
// Behaviour against a real database is proven by supabase/ci/pr04-pr03-compat-test.sql (+ the PR-03 suites themselves).

const dir = resolve(process.cwd(), 'supabase/migrations')
const PR03 = '20261128000000_conversation_routing.sql'
const PR04 = [
  '20261129000000_order_logistics_model.sql',
  '20261129000001_order_logistics_security_rpcs.sql',
  '20261129000002_order_docs_storage.sql',
  '20261129000003_order_evidence_rpc.sql',
  '20261129000004_order_template_dispatch_rpcs.sql',
  '20261129000005_order_evidence_upload.sql',
]
// PR-05 (Shalom tracking) migrations come after PR-04's: they are later still, so the "files after PR-03" arithmetic below must count them too.
const PR05_PREFIX = '202611300000'
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n')
const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '')
const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const pr05 = all.filter((f) => f.startsWith(PR05_PREFIX))

/** SHA-256 of the PR-03 migration (LF-normalized) as closed at a1d76f3fb89439b692967f5781033ada058a9784. */
const PR03_SHA256 = '931ad2b6597b8995c89c2d435fc7b35f12bbdccb6d4643571dad58fe43ffa298'

describe('PR-03 migration is still present and unmodified', () => {
  it('has exactly the content it had when PR-03 was frozen', () => {
    expect(createHash('sha256').update(read(PR03)).digest('hex')).toBe(PR03_SHA256)
  })

  it('keeps its semantics: absence of a row = commercial, three stages, append-only audit, the historical RPCs', () => {
    const code = strip(read(PR03))
    expect(read(PR03)).toMatch(/ABSENCE OF A ROW IN conversation_routing MEANS stage = 'commercial'/)
    expect(code).toMatch(/stage\s+TEXT NOT NULL CHECK \(stage IN \('commercial', 'logistics', 'shared'\)\)/)
    expect(code).toMatch(/conversation_routing_events is append-only/)
    for (const fn of ['apply_order_confirmed_routing', 'derive_conversation_to_commercial', 'backfill_conversation_routing', 'conversation_operational_access', 'create_order_confirmation']) {
      expect(code, fn).toMatch(new RegExp(`FUNCTION public\\.${fn}\\(`))
    }
  })
})

describe('PR-04 migrations are strictly later and independent of PR-03', () => {
  it('sort after the PR-03 migration, contiguous and in order', () => {
    const i = all.indexOf(PR03)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(all.slice(i + 1, i + 1 + PR04.length)).toEqual(PR04)
    for (const name of PR04) expect(all.indexOf(name)).toBeGreaterThan(i)
  })

  it('never create, alter, drop or write the PR-03 tables / functions / policies, nor redefine create_order_confirmation or the access helper', () => {
    const tables = '(conversation_routing_events|conversation_routing)'
    const functions = '(apply_order_confirmed_routing|derive_conversation_to_commercial|backfill_conversation_routing|conversation_operational_access|create_order_confirmation)'
    for (const name of PR04) {
      const code = strip(read(name))
      expect(code, name).not.toMatch(new RegExp(`(CREATE|ALTER|DROP)\\s+(OR\\s+REPLACE\\s+)?(TABLE|INDEX|TRIGGER|POLICY|FUNCTION)[^;]*\\b${tables}\\b`, 'i'))
      expect(code, name).not.toMatch(new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(public\\.)?${tables}\\b`, 'i'))
      expect(code, name).not.toMatch(new RegExp(`(CREATE\\s+OR\\s+REPLACE\\s+FUNCTION|DROP\\s+FUNCTION)\\s+(IF\\s+EXISTS\\s+)?public\\.${functions}\\b`, 'i'))
      expect(code, name).not.toMatch(/ALTER\s+PUBLICATION/i)
    }
  })

  it('only READ conversations / messages (evidence validation); they never write them', () => {
    for (const name of PR04) expect(strip(read(name)), name).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?(conversations|messages)\b/i)
  })
})

describe('the frozen PR-03 test: what its failure is and is not', () => {
  it('the frozen "last migration" assertion holds over the PR-03-era file list and fails only because PR-04 files exist after it', () => {
    const era = all.filter((f) => !PR04.includes(f) && !pr05.includes(f))
    expect(era.indexOf(PR03)).toBe(era.length - 1) // the invariant PR-03 asserted: true without the PR-04 migrations
    expect(all.indexOf(PR03)).toBe(all.length - 1 - PR04.length - pr05.length) // ...and exactly the PR-04 (and later PR-05) files are what come after it
  })

  it('the other assertion of that test (sorts after the PR-02 migrations) still holds', () => {
    expect(all.indexOf(PR03)).toBeGreaterThan(all.indexOf('20261127000000_conversation_handoff_rls.sql'))
  })

  it('the frozen test file itself is untouched', () => {
    const frozen = readFileSync(resolve(process.cwd(), 'src/lib/orders/migration-conversation-routing.test.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(frozen).toContain("expect(all.indexOf(name)).toBe(all.length - 1)")
    expect(createHash('sha256').update(frozen).digest('hex')).toBe('acd92efa8573ee111966ea6d543ec00d44592d9299e70adb7c700ce59ed374e9')
  })
})
