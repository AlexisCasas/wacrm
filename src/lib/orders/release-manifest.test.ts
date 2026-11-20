import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Integration release (production source + PR-02..PR-06): the 22 PR migrations live in ONE new contiguous block AFTER every migration production applied and every
// version another branch reserves, with the same relative order; the production migrations stay exactly what production ran. supabase/release/migration-manifest.json is
// the OLD -> NEW record; scripts/release/migration-ledger.cjs is the (local, read-only) checker the future deploy uses.

const root = process.cwd()
const manifest = JSON.parse(readFileSync(resolve(root, 'supabase/release/migration-manifest.json'), 'utf8')) as {
  production_baseline: Array<{ version: string; file: string; sha256: string; recorded_in_applied: boolean }>
  reserved_external: Array<{ version: string }>
  release_migrations: Array<{ order: number; old_version: string; old_file: string; new_version: string; new_file: string; sha256: string }>
}
const files = readdirSync(resolve(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
const version = (f: string) => f.split('_')[0]

describe('release migration block', () => {
  it('the checker agrees (names, order, contiguity, uniqueness, checksums)', () => {
    const out = execFileSync(process.execPath, ['scripts/release/migration-ledger.cjs', 'verify'], { cwd: root }).toString()
    expect(out).toMatch(/VERIFY OK: 22 release migrations 20261204000000\.\.20261204000021/)
  })

  it('every migration version is unique (the CI rule "no duplicated versions")', () => {
    const versions = files.map(version)
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([])
  })

  it('the 22 keep their original relative order and sort after EVERY production / reserved version', () => {
    const olds = manifest.release_migrations.map((m) => m.old_version)
    expect([...olds].sort()).toEqual(olds)
    const news = manifest.release_migrations.map((m) => m.new_version)
    expect(news).toHaveLength(22)
    const maxExternal = [...manifest.production_baseline.map((p) => p.version), ...manifest.reserved_external.map((r) => r.version)].sort().at(-1)!
    for (const v of news) expect(v > maxExternal).toBe(true)
    expect(files.slice(files.indexOf(manifest.release_migrations[0].new_file))).toEqual(manifest.release_migrations.map((m) => m.new_file)) // nothing else after the block, nothing in between
  })

  it('the production migrations (applied by hand, recorded in .applied) are in the tree and unchanged', () => {
    for (const p of manifest.production_baseline) expect(files, p.file).toContain(p.file)
    const recorded = manifest.production_baseline.filter((p) => p.recorded_in_applied)
    expect(recorded.map((p) => p.version)).toEqual(['20261126000000', '20261127000000'])
    // the sha256 production recorded in its own .applied files (read-only audit, 2026-11-19)
    const sha = Object.fromEntries(recorded.map((p) => [p.version, p.sha256]))
    expect(sha['20261126000000']).toBe('fa2ed3a147ddbd47ebe1c7b51723c028f0e651f9d119100f6990b75635aac8ae')
    expect(sha['20261127000000']).toBe('c90573bcb86fa9091a1d612ed339b23a1e3891fac4abf7436103168a131d6cdd')
  })

  it('the PR-03 routing migration keeps the exact content PR-03 froze (the rename changed nothing inside the SQL)', () => {
    const m = manifest.release_migrations.find((r) => r.old_file === '20261128000000_conversation_routing.sql')!
    expect(m.new_file).toBe('20261204000002_conversation_routing.sql')
    expect(m.sha256).toBe('931ad2b6597b8995c89c2d435fc7b35f12bbdccb6d4643571dad58fe43ffa298')
  })
})
