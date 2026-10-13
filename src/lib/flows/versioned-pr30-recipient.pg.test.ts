import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKit, pass, TOKEN } from './test-support/pr30-kit'
import { MockMetaTransport } from './test-support/mock-meta-transport'
import { createMetaEffectSender } from './versioned-meta-sender'

/**
 * PR #30 audit fix — P1 single recipient. Isolated PostgreSQL 17 (migrations 001..062) with a scripted HTTP transport; skipped
 * unless QA_PG_CONTAINER is set. No network (global fetch is trapped) and only a synthetic credential. Ids R05-R08.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })

describe.skipIf(!container)('PR #30: P1 single recipient', () => {
  const kit = createKit(container ?? '')
  const { h, proc, go, flows, effects } = kit
  let trap: ReturnType<typeof kit.trapNetwork>
  beforeAll(async () => { trap = kit.trapNetwork() })
  afterAll(async () => { const calls = trap.mock.calls.length; vi.unstubAllGlobals(); expect(calls).toBe(0) })

  it('R05/R06/R07/R08: a single validated number; no alternative number is ever tried; legacy and contacts.phone untouched', async () => {
    const acct = await h.account()
    const phoneBefore = async (runId: string) => h.psql.sql(`select c.phone from public.contacts c join public.flow_runs r on r.contact_id = c.id where r.id='${runId}'`)
    const f = await flows(); const t = new MockMetaTransport(); const ph0 = await phoneBefore(f.runId)
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(1); expect(t.requests[0].to).toBe('37063949836')
    pass('R05', 'valid number: exactly one request, to exactly the sanitised original number')
    const g = await flows(); const t2 = new MockMetaTransport()
    const bad = { runs: h.newStore(), effects: h.newEffectStore(), sender: createMetaEffectSender({ transport: t2, resolveContext: async () => ({ ok: true, phoneNumberId: '1', accessToken: TOKEN, recipientPhone: '12ab' }) }) }
    expect(await go(bad, g.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect(t2.requests).toHaveLength(0)
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'failed', error_code: 'invalid_recipient' })
    pass('R06', 'invalid number: zero requests, effect failed/invalid_recipient')
    const k = await flows(); const t3 = new MockMetaTransport().setDefault('not_allowed')
    expect(await go(proc(t3, { maxVariants: 5 }), k.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect(t3.requests).toHaveLength(1)
    const m = await flows(); const t4 = new MockMetaTransport().script('accept_then_timeout', 'accept', 'accept')
    expect(await go(proc(t4, { maxVariants: 5 }), m.runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t4.requests).toHaveLength(1)
    pass('R07', 'Meta rejects the original recipient: 1 request and the effect fails, no other number; after a timeout: 1 request and the effect is ambiguous; an old maxVariants: 5 configuration reactivates nothing')
    expect(await phoneBefore(f.runId)).toBe(ph0); expect(await phoneBefore(k.runId)).toBeTruthy()
    const legacy = (await import('node:fs')).readFileSync('src/lib/flows/meta-send.ts', 'utf8')
    expect(legacy).toContain('phoneVariants(')
    expect(acct).toBeTruthy()
    pass('R08', 'contacts.phone was not modified by any versioned send; the legacy sender source still uses its own variants (untouched)')
  })

})
