import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKit, pass } from './test-support/pr30-kit'
import { MockMetaTransport } from './test-support/mock-meta-transport'

/**
 * PR #30 audit round 2 (migrations 063 + 064). Isolated PostgreSQL 17 with a scripted HTTP transport; skipped unless
 * QA_PG_CONTAINER is set. No network (global fetch is trapped), synthetic credential only. Ids R23+.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })

describe.skipIf(!container)('PR #30 audit round 2', () => {
  const kit = createKit(container ?? '')
  const { h, proc, go, inbox, effects, links } = kit
  let trap: ReturnType<typeof kit.trapNetwork>
  beforeAll(async () => { trap = kit.trapNetwork(); await kit.installOutage() })
  afterAll(async () => { await kit.removeOutage(); const calls = trap.mock.calls.length; vi.unstubAllGlobals(); expect(calls).toBe(0) })

  let seq = 9_000_000 + Math.floor(Math.random() * 900_000)
  /** start -> m1 ("Mensaje A") -> m2 ("Mensaje B") -> end, a run WITH a conversation */
  async function twoMessages() {
    const F = h.id()
    await h.synth(F, [h.start('s', 'm1'), kit.msg('m1', 'Mensaje A', 'm2'), kit.msg('m2', 'Mensaje B', 'e'), h.end('e')], 's')
    const runId = await h.psql.sql(`select public.qa_flow_run_conv('${F}', ${++seq})`)
    const run = await h.run(runId)
    return { runId, conversationId: run.conversation_id as string }
  }
  const conversation = async (id: string) => (await h.psql.rows<{ last_message_text: string | null; last_message_at: string | null }>(`select last_message_text, last_message_at::text from public.conversations where id='${id}'`))[0]

  it('R23: A confirmed without Inbox, B newer, then A repaired: A is stored before B, the preview stays B, nothing is resent', async () => {
    const f = await twoMessages(); const t = new MockMetaTransport(); const p = proc(t); const acct = await h.account()
    // the Inbox is down for the first send only: it comes back before the second one is dispatched
    let sends = 0; const inner = p.sender
    p.sender = { send: async (r) => { if (++sends === 2) await kit.outage(false); return inner.send(r) } }
    await kit.outage(true)
    expect(await go(p, f.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(2)
    const [ea, eb] = await effects(f.runId)
    expect([ea.state, eb.state]).toEqual(['confirmed', 'confirmed'])
    expect((await inbox(f.conversationId)).map((m) => m.content_text)).toEqual(['Mensaje B'])      // A has no Inbox row yet
    const before = await conversation(f.conversationId)
    expect(before.last_message_text).toBe('Mensaje B')
    const runBefore = JSON.stringify(await h.run(f.runId)); const effBefore = JSON.stringify(await effects(f.runId))
    const rep = await p.effects.repairInbox(acct, f.runId)
    expect(rep).toEqual([
      { effectId: ea.id, messageId: expect.any(String), outcome: 'created', reason: null },
      { effectId: eb.id, messageId: expect.any(String), outcome: 'already_persisted', reason: null },
    ])
    const rows = await inbox(f.conversationId)
    expect(rows.map((m) => m.content_text)).toEqual(['Mensaje A', 'Mensaje B'])                      // ordered by time, not by repair time
    expect(new Date(rows[0].created_at).getTime()).toBe(new Date(ea.finished_at).getTime())          // persisted confirmation time
    expect(new Date(rows[1].created_at).getTime()).toBe(new Date(eb.finished_at).getTime())
    expect(await conversation(f.conversationId)).toEqual(before)                                      // preview and last_message_at untouched
    expect(JSON.stringify(await h.run(f.runId))).toBe(runBefore)                                      // run untouched
    expect(JSON.stringify(await effects(f.runId))).toBe(effBefore)
    expect(await links(f.runId)).toHaveLength(2)
    // idempotent, and still no resend
    expect(await p.effects.repairInbox(acct, f.runId)).toEqual([
      { effectId: ea.id, messageId: rows[0].id, outcome: 'already_persisted', reason: null },
      { effectId: eb.id, messageId: rows[1].id, outcome: 'already_persisted', reason: null },
    ])
    expect(await inbox(f.conversationId)).toHaveLength(2); expect(await conversation(f.conversationId)).toEqual(before)
    expect(t.requests).toHaveLength(2)
    pass('R23', 'Meta (simulated) confirmed A with the Inbox down and B after it came back; repairing A afterwards stores it at its confirmation time before B, leaves the preview and last_message_at on B, the run and effects byte-identical, a second repair is a no-op and Meta saw exactly 2 requests')
  })
})
