import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKit, pass } from './test-support/pr30-kit'
import { MockMetaTransport } from './test-support/mock-meta-transport'

/**
 * PR #30 audit fix — P1 Inbox repair for ended runs. Isolated PostgreSQL 17 (migrations 001..062) with a scripted HTTP transport; skipped
 * unless QA_PG_CONTAINER is set. No network (global fetch is trapped) and only a synthetic credential. Ids R01-R04.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })

describe.skipIf(!container)('PR #30: P1 Inbox repair for ended runs', () => {
  const kit = createKit(container ?? '')
  const { h, proc, go, flows, inbox, effects, links } = kit
  let trap: ReturnType<typeof kit.trapNetwork>
  beforeAll(async () => { trap = kit.trapNetwork(); await kit.installOutage() })
  afterAll(async () => { await kit.removeOutage(); const calls = trap.mock.calls.length; vi.unstubAllGlobals(); expect(calls).toBe(0) })

  it('R01: Inbox outage -> accepted -> run completes -> Inbox back -> repair inserts the message once, no resend', async () => {
    const f = await flows(); const t = new MockMetaTransport(); const p = proc(t); const acct = await h.account()
    await kit.outage(true)
    expect(await go(p, f.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(1)
    const [eff] = await effects(f.runId)
    expect(eff).toMatchObject({ state: 'confirmed', provider_message_id: t.wamids[0] })
    expect(await inbox(f.conversationId)).toHaveLength(0)                    // the outage: confirmed but not in the Inbox
    expect(await links(f.runId)).toHaveLength(0)
    const errs = (await h.events(f.runId)).filter((e) => e.event_type === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0].payload).toMatchObject({ reason: 'inbox_persist_failed', effect_id: eff.id })
    expect(JSON.stringify(await h.events(f.runId))).not.toContain('Hola Ana')
    // the run is over: the lease-based reconcile (060) can no longer help
    const runDone = await h.run(f.runId)
    expect(runDone).toMatchObject({ status: 'completed', versioned_messages_executed: 1 })
    await kit.outage(false)
    const before = JSON.stringify(await h.run(f.runId)); const effBefore = JSON.stringify((await effects(f.runId))[0])
    const rep = await p.effects.repairInbox(acct, f.runId)
    expect(rep).toEqual([{ effectId: eff.id, messageId: expect.any(String), outcome: 'created', reason: null }])
    const rows = await inbox(f.conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender_type: 'bot', content_type: 'text', content_text: 'Hola Ana', message_id: t.wamids[0], status: 'sent' })
    const [l] = await links(f.runId)
    expect(l).toMatchObject({ effect_id: eff.id, message_id: rows[0].id, provider_message_id: t.wamids[0], attempt: 1 })
    expect(JSON.stringify(await h.run(f.runId))).toBe(before)                  // still completed, nothing moved
    expect(JSON.stringify((await effects(f.runId))[0])).toBe(effBefore)
    // twice changes nothing
    expect(await p.effects.repairInbox(acct, f.runId)).toEqual([{ effectId: eff.id, messageId: rows[0].id, outcome: 'already_persisted', reason: null }])
    expect(await inbox(f.conversationId)).toHaveLength(1); expect(await links(f.runId)).toHaveLength(1)
    expect(t.requests).toHaveLength(1)                                         // no resend to the provider
    expect((await h.run(f.runId)).status).toBe('completed')
    pass('R01', 'Meta (simulated) accepted; Inbox down: effect confirmed, run advanced to completed, no message; Inbox restored: repair inserted the message (sent) and its link, run and effect byte-identical, second repair already_persisted, still 1 HTTP request')
  })

  it('R02: a persistent Inbox failure is reported, writes no partial state and exposes no text', async () => {
    const f = await flows(); const t = new MockMetaTransport(); const p = proc(t); const acct = await h.account()
    await kit.outage(true)
    await go(p, f.runId, 'w1')
    const before = JSON.stringify(await h.run(f.runId))
    for (let i = 0; i < 2; i++) {
      const rep = await p.effects.repairInbox(acct, f.runId)
      expect(rep).toHaveLength(1)
      expect(rep[0]).toMatchObject({ outcome: 'failed', reason: 'P9997', messageId: null })
    }
    expect(await inbox(f.conversationId)).toHaveLength(0); expect(await links(f.runId)).toHaveLength(0)
    expect(JSON.stringify(await h.run(f.runId))).toBe(before)
    const repairErrs = (await h.events(f.runId)).filter((e) => e.payload.reason === 'inbox_repair_failed')
    expect(repairErrs).toHaveLength(2)
    expect(JSON.stringify(await h.events(f.runId))).not.toContain('Hola Ana')
    await kit.outage(false)
    expect(await p.effects.repairInbox(acct, f.runId)).toEqual([expect.objectContaining({ outcome: 'created' })])
    expect(t.requests).toHaveLength(1)
    pass('R02', 'outage still on: repair reports failed/P9997 twice, no message or link, run untouched, 2 id-only error events without message text; once the Inbox is back the same call creates the message')
  })

  it('R03/R04: concurrent repairs create one row; another account cannot repair', async () => {
    const f = await flows(); const t = new MockMetaTransport(); const p = proc(t); const acct = await h.account()
    await kit.outage(true); await go(p, f.runId, 'w1'); await kit.outage(false)
    const [a, b] = await Promise.all([h.newEffectStore().repairInbox(acct, f.runId), h.newEffectStore().repairInbox(acct, f.runId)])
    const outcomes = [a[0].outcome, b[0].outcome].sort()
    expect(outcomes).toEqual(['already_persisted', 'created'])
    expect(await inbox(f.conversationId)).toHaveLength(1); expect(await links(f.runId)).toHaveLength(1)
    pass('R03', 'two repair processes racing on the same completed run: outcomes [already_persisted, created], 1 message, 1 link')
    await expect(p.effects.repairInbox('99999999-0000-4000-8000-000000000000', f.runId)).rejects.toMatchObject({ code: 'P0002' })
    expect(await inbox(f.conversationId)).toHaveLength(1)
    pass('R04', 'another account (and in SQL a legacy run) is refused with P0002; the Inbox is untouched')
  })

})
