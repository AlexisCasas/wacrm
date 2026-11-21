import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// "EVERY communication that carries pending_balance goes through the trust cutoff": the cutoff lives in resolveOrderBalance (payments/balance.ts) and is the ONLY place
// that produces a customer-facing pending balance. This guard fails if any other production source builds template params with a pending_balance without resolving it there.
const ROOT = resolve(process.cwd(), 'src')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.(test|qa\.test)\.(ts|tsx)$/.test(f) ? [p] : []
})

describe('customer-facing balance call sites', () => {
  const sources = walk(ROOT).map((p) => ({ p: p.split('\\').join('/'), t: readFileSync(p, 'utf8') }))

  it('every production file that passes a pending_balance into buildTemplateBodyParams resolves it with resolveOrderBalance', () => {
    const users = sources.filter((s) => /buildTemplateBodyParams\s*\(/.test(s.t) && /pending_balance\s*:/.test(s.t) && !s.p.endsWith('logistics/template-params.ts'))
    expect(users.length).toBeGreaterThanOrEqual(2) // packaging + customer-message (arrival / day-15)
    for (const u of users) {
      expect(u.t, u.p).toMatch(/resolveOrderBalance\s*\(/)
      expect(u.t, u.p).toMatch(/balanceErrorCode\s*\(/) // and surface the trust refusal with its stable code
    }
  })

  it('no other production code formats a customer balance by itself (formatSoles is only used next to a resolved balance)', () => {
    const users = sources.filter((s) => /formatSoles\s*\(/.test(s.t) && !s.p.endsWith('payments/balance.ts'))
    for (const u of users) expect(u.t, u.p).toMatch(/resolveOrderBalance\s*\(/)
  })

  it('the cutoff itself is fail-closed in resolveOrderBalance (NULL or earlier confirmation => balance_not_trusted)', () => {
    const t = sources.find((s) => s.p.endsWith('payments/balance.ts'))!.t
    expect(t).toMatch(/balance_trusted_since/)
    expect(t).toMatch(/balance_not_trusted/)
    expect(t).toMatch(/if \(!isTrusted\(/)
  })
})
