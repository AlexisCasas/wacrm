import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PostgreSQL custom setting names ("a.b.c") need EVERY part to start with a letter or "_". A flow id (uuid) can start with a digit, so a setting
// name built from it must carry a letter prefix. 20261122000000 shipped without one: saving the nodes of a flow whose id starts with 0-9 failed
// with SQLSTATE 42602 at COMMIT ("Could not save flow"). See 20261124000000.
const dir = resolve(process.cwd(), 'supabase/migrations')
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const read = (f: string) => readFileSync(resolve(dir, f), 'utf8')
const fix = read('20261124000000_fix_bsuid_autoauth_node_trigger_key.sql')
const code = fix.replace(/^--.*$/gm, '')

describe('20261124000000_fix_bsuid_autoauth_node_trigger_key', () => {
  it('redefines only the node trigger function and prefixes the key with a letter', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1)
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.bsuid_flow_autoauth_on_node\(\)/)
    expect(code).toContain("'wacrm.bsuid_autoauth.f_' || replace(v_flow::text, '-', '_')")
    expect(code).toMatch(/SECURITY DEFINER SET search_path = public/)
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|ALTER|GRANT|REVOKE)\b/i)
  })

  it('sorts after the migration it fixes, so a clean replay ends with the fixed function', () => {
    expect(files.indexOf('20261124000000_fix_bsuid_autoauth_node_trigger_key.sql')).toBeGreaterThan(files.indexOf('20261122000000_bsuid_flow_auto_authorization.sql'))
  })

  it('no migration builds a set_config key from a uuid without a letter prefix (the LAST definition is what counts)', () => {
    const last = files.filter((f) => /v_key text := 'wacrm\.bsuid_autoauth\./.test(read(f))).pop()!
    expect(last).toBe('20261124000000_fix_bsuid_autoauth_node_trigger_key.sql')
    expect(read(last).replace(/^--.*$/gm, '')).not.toMatch(/'wacrm\.bsuid_autoauth\.'\s*\|\|/)
  })
})
