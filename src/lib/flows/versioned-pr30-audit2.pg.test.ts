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

  // ---------------------------------------- case 3: a Retry-After above one day is never shortened
  it('R24/R25: a Retry-After above a day is honoured exactly up to 7 days; above that the effect fails definitively', async () => {
    const wait = async (header: string) => {
      const f = await kit.flows(); const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = header
      const out = await go(proc(t), f.runId, 'w1')
      return { f, t, out }
    }
    for (const sec of [86400, 86401, 100000, 604800]) {
      const { f, t, out } = await wait(String(sec))
      expect(out, `${sec}`).toMatchObject({ kind: 'effect_retry_scheduled', attempts: 1 })
      const left = await kit.secondsUntilRetry(f.runId)
      expect(left, `${sec}`).toBeGreaterThan(sec - 10); expect(left, `${sec}`).toBeLessThanOrEqual(sec)           // not shortened, not backoff
      expect((await h.events(f.runId)).filter((e) => e.event_type === 'effect_deferred')[0].payload, `${sec}`).toMatchObject({ wait_seconds: sec, wait_source: 'retry_after' })
      expect(t.requests, `${sec}`).toHaveLength(1)
      expect(await h.run(f.runId), `${sec}`).toMatchObject({ status: 'active', versioned_messages_executed: 0 })
    }
    pass('R24', 'Retry-After 86400, 86401, 100000 and 604800 s each persist exactly that wait (event wait_source retry_after, remaining time within 10 s of it): never the 30..900 s backoff, never clamped to a day; run active, budget 0, 1 request')
    // 7 days + 1 s, and a header that does not even fit an integer: the effect fails, nothing is deferred or retried
    for (const header of ['604801', '99999999', '999999999']) {
      const { f, t, out } = await wait(header)
      expect(out, header).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
      const [eff] = await effects(f.runId)
      expect(eff, header).toMatchObject({ state: 'failed', error_code: 'retry_after_exceeds_limit', retry_not_before: null, provider_message_id: null })
      expect((await h.events(f.runId)).filter((e) => e.event_type === 'effect_deferred'), header).toHaveLength(0)
      expect(await inbox(f.conversationId), header).toHaveLength(0)
      expect(await go(proc(t), f.runId, 'again'), header).toMatchObject({ kind: 'not_active' })
      expect(t.requests, header).toHaveLength(1)                                                    // never resent
      expect(await h.run(f.runId), header).toMatchObject({ status: 'failed', versioned_messages_executed: 0 })
    }
    pass('R25', 'Retry-After 604801 s, 99999999 s and 999999999 s: the run fails definitively with retry_after_exceeds_limit (effect failed, no retry time, no deferral event, no Inbox row), a new invocation does nothing and Meta saw exactly 1 request each')
  })

  it('R26: a long persisted wait survives a process restart and is enforced to the end', async () => {
    const f = await kit.flows(); const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = '100000'
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'effect_retry_scheduled' })
    const [eff0] = await effects(f.runId)
    const idle = new MockMetaTransport()                                                            // a fresh process: it must never be asked to send
    for (let i = 0; i < 3; i++) expect(await go(proc(idle), f.runId, `restart-${i}`)).toMatchObject({ kind: 'effect_retry_scheduled' })
    expect(idle.requests).toHaveLength(0)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'pending', attempt: 1, retry_not_before: eff0.retry_not_before })
    expect(t.requests).toHaveLength(1)
    // when the persisted time passes the successor sends exactly once more
    await kit.makeDue(f.runId)
    const t2 = new MockMetaTransport()
    expect(await go(proc(t2), f.runId, 'w2')).toMatchObject({ kind: 'completed' })
    expect(t2.requests).toHaveLength(1)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'confirmed', attempt: 2 })
    expect(await inbox(f.conversationId)).toHaveLength(1)
    pass('R26', 'a 100000 s wait: three fresh processes before the time all report effect_retry_scheduled with the same persisted time and send nothing; once due, one new process sends exactly once (attempt 2) and the message reaches the Inbox once')
  })
})
