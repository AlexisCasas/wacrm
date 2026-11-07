import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The evidence helpers of the release package (lib.sh) and how 50-swap-image.sh / 60-postchecks.sh use them. Runs bash against a temp dir with a stubbed `docker`.
const REL = join(__dirname, '../../../../scripts/ops/orders-sheets/release')
const sh = (d: string, body: string) => execFileSync('bash', ['-c', `export RELEASE_DIR=${d}; . ${REL}/lib.sh; docker() { printf 'wacrm-app-1\\twacrm-app:x\\tUp 2 hours (healthy)\\nsupabase-db\\tsupabase/postgres\\tUp 9 days\\n'; }; ${body}`], { encoding: 'utf8' })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'rel-')); return d }

describe('release evidence', () => {
  it('containers-before.txt is NAMES ONLY (what 60-postchecks compares); the detailed list keeps its own name', () => {
    const d = dir(); sh(d, 'record_containers')
    expect(readFileSync(join(d, 'containers-before.txt'), 'utf8')).toBe('supabase-db\nwacrm-app-1\n')
    expect(readFileSync(join(d, 'containers-before-swap.txt'), 'utf8')).toContain('\twacrm-app:x\t')
  })
  it('a second run never destroys the first run\'s evidence', () => {
    const d = dir(); sh(d, 'record_containers'); sh(d, 'record_containers')
    const kept = readdirSync(join(d, 'evidence/previous'))
    expect(kept.filter((f) => f.startsWith('containers-before.txt.'))).toHaveLength(1)
    expect(kept.filter((f) => f.startsWith('containers-before-swap.txt.'))).toHaveLength(1)
  })
  it('T0.txt keeps every line (the old script truncated it half way) and is validated as complete', () => {
    const d = dir()
    sh(d, `t0_start; echo 'T0 fnmd5=a=1' >> $D/T0.txt; echo 'T0 export tables=4' >> $D/T0.txt; echo 'T0 orders=2 items=3 fp=abc' >> $D/T0.txt; echo 'T0 cutoff=2026' >> $D/T0.txt; echo 'T0 switches=x' >> $D/T0.txt; t0_complete`)
    expect(readFileSync(join(d, 'T0.txt'), 'utf8').trim().split('\n')).toHaveLength(5)
    // incomplete evidence is refused instead of silently comparing against nothing
    const d2 = dir(); writeFileSync(join(d2, 'T0.txt'), 'T0 orders=2 items=3 fp=abc\n')
    expect(() => sh(d2, 't0_complete')).toThrow()
    // a re-run archives the previous T0 and starts clean
    sh(d2, 't0_start')
    expect(readFileSync(join(d2, 'T0.txt'), 'utf8')).toBe(''); expect(readdirSync(join(d2, 'evidence/previous'))[0]).toMatch(/^T0\.txt\./)
  })
  it('50-swap-image.sh starts T0.txt before it writes any T0 line, appends only, and checks completeness before swapping', () => {
    const s = readFileSync(join(REL, '50-swap-image.sh'), 'utf8')
    const start = s.indexOf('t0_start'), firstWrite = s.indexOf("'T0 ")
    expect(start).toBeGreaterThan(-1); expect(start).toBeLessThan(firstWrite)
    expect(s).not.toMatch(/\| tee \$D\/T0\.txt/)
    expect(s.indexOf('t0_complete')).toBeLessThan(s.indexOf('up -d --no-deps'))
    expect(s).toContain('record_containers')
  })
  it('60-postchecks.sh reads the files 50 writes, keeps per-run evidence and lets another release be declared', () => {
    const s = readFileSync(join(REL, '60-postchecks.sh'), 'utf8')
    expect(s).toContain('$D/containers-before.txt'); expect(s).not.toContain('$D/NOW-statuses.txt')
    expect(s).toContain('evidence/postcheck'); expect(s).toContain('EXPECT_IMAGE'); expect(s).toContain('t0_complete')
    expect(existsSync(join(REL, 'lib.sh'))).toBe(true)
  })
})
