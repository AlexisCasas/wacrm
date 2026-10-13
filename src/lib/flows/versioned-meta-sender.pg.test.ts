import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runVersionedFlow, type RunVersionedFlowOptions } from './versioned-interpreter'
import { resolveAmbiguousEffect, type EffectSender, type OutboundRequest } from './versioned-messaging'
import { createMetaEffectSender, type MetaSenderEvent } from './versioned-meta-sender'
import { createHarness, type NodeSpec } from './test-support/versioned-pg'
import { MockMetaTransport } from './test-support/mock-meta-transport'

/**
 * E4.2C3.1: interpreter + Meta adapter + Inbox persistence against the isolated PostgreSQL 17 container
 * (migrations 001..060), with a scripted HTTP transport. Skipped unless QA_PG_CONTAINER is set. No test can reach a
 * network (global fetch is trapped) and the only credential is a synthetic string.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)
const TOKEN = 'SYNTHETIC-TOKEN-NOT-REAL-9f3a'

describe.skipIf(!container)('E4.2C3.1 Meta adapter offline through the interpreter and the Inbox', () => {
  const h = createHarness(container ?? '')
  const { call, start, end } = h
  const msg = (key: string, text: string, next: string): NodeSpec => ({ key, type: 'send_message', config: { text, next_node_key: next } })
  const media = (key: string, next: string, caption?: string): NodeSpec => ({ key, type: 'send_media', config: { media_type: 'image', media_url: 'https://example.test/pic.png', ...(caption ? { caption } : {}), next_node_key: next } })
  const fetchTrap = vi.fn(() => { throw new Error('network access is forbidden in these tests') })
  beforeAll(() => { vi.stubGlobal('fetch', fetchTrap) })
  afterAll(() => { vi.unstubAllGlobals() })

  const events: MetaSenderEvent[] = []
  const metaSender = (t: MockMetaTransport, extra: { maxVariants?: number } = {}): EffectSender =>
    createMetaEffectSender({ transport: t, resolveContext: async () => ({ ok: true, phoneNumberId: '1234567890', accessToken: TOKEN, recipientPhone: '+37063949836' }), onEvent: (e) => events.push(e), ...extra })
  type Proc = { runs: ReturnType<typeof h.newStore>; effects: ReturnType<typeof h.newEffectStore>; sender: EffectSender }
  const proc = (t: MockMetaTransport, extra = {}): Proc => ({ runs: h.newStore(), effects: h.newEffectStore(), sender: metaSender(t, extra) })
  function dying(t: MockMetaTransport, target: { method: string; when: 'before' | 'after'; nth?: number }): Proc {
    const death = h.processDeath()
    const inner = metaSender(t)
    return { runs: death.wrap(h.newStore()), effects: death.wrap(h.newEffectStore(), target), sender: death.wrap({ send: (r: OutboundRequest) => inner.send(r) }) }
  }
  const go = async (p: Proc, runId: string, owner: string, extra: Partial<RunVersionedFlowOptions> = {}) =>
    runVersionedFlow(p.runs, { accountId: await h.account(), runId, owner, messaging: { effects: p.effects, sender: p.sender }, ...extra })

  async function convRun(flowId: string, n: number) {
    const runId = await h.psql.sql(`select public.qa_flow_run_conv('${flowId}', ${n})`)
    const run = await h.run(runId)
    return { runId, conversationId: run.conversation_id as string }
  }
  let seq = 5000 + Math.floor(Math.random() * 3_000_000)
  /** A: start -> call(B) -> fin ; B: bstart -> bmsg -> bend */
  async function flows(bNodes?: NodeSpec[]) {
    const A = h.id(), B = h.id()
    await h.synth(B, bNodes ?? [start('bstart', 'bmsg'), msg('bmsg', 'Hola {{vars.name}}', 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    const r = await convRun(A, ++seq)
    await h.psql.sql(`update public.flow_runs set vars='{"name":"Ana"}' where id='${r.runId}'`)
    return { A, B, ...r }
  }
  const inbox = (conversationId: string) => h.psql.rows<Record<string, any>>(`select * from public.messages where conversation_id='${conversationId}' order by created_at, id`) // eslint-disable-line @typescript-eslint/no-explicit-any
  const effects = (runId: string) => h.psql.rows<Record<string, any>>(`select * from public.flow_run_effects where flow_run_id='${runId}' order by occurrence_revision`) // eslint-disable-line @typescript-eslint/no-explicit-any
  const links = (runId: string) => h.psql.rows<Record<string, any>>(`select * from public.flow_run_effect_messages where flow_run_id='${runId}'`) // eslint-disable-line @typescript-eslint/no-explicit-any

  it('N01/N02: accepted text and media reach the Inbox once, with the wamid, as "sent"', async () => {
    const f = await flows()
    const t = new MockMetaTransport()
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(1); expect(t.delivered).toHaveLength(1)
    expect(t.requests[0].body).toMatchObject({ messaging_product: 'whatsapp', type: 'text', text: { body: 'Hola Ana' } })
    expect(t.requests[0].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    const rows = await inbox(f.conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender_type: 'bot', content_type: 'text', content_text: 'Hola Ana', message_id: t.wamids[0], status: 'sent', media_url: null })
    const [l] = await links(f.runId); const [e] = await effects(f.runId)
    expect(l).toMatchObject({ effect_id: e.id, message_id: rows[0].id, provider_message_id: t.wamids[0], attempt: 1 })
    expect(await h.run(f.runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 1 })
    const conv = (await h.psql.rows<Record<string, any>>(`select last_message_text from public.conversations where id='${f.conversationId}'`))[0] // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(conv.last_message_text).toBe('Hola Ana')
    pass('N01', 'text accepted with a synthetic wamid: 1 HTTP request (Bearer synthetic token), 1 effect, 1 Inbox row (bot/text, wamid, status sent), link to the effect and attempt, conversation preview updated, run completed')

    const g = await flows([start('bstart', 'pic'), media('pic', 'bend', 'Para {{vars.name}}'), end('bend')])
    const t2 = new MockMetaTransport()
    expect(await go(proc(t2), g.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t2.requests[0].body).toMatchObject({ type: 'image', image: { link: 'https://example.test/pic.png', caption: 'Para Ana' } })
    const [mrow] = await inbox(g.conversationId)
    expect(mrow).toMatchObject({ content_type: 'image', content_text: 'Para Ana', media_url: 'https://example.test/pic.png', message_id: t2.wamids[0], status: 'sent' })
    pass('N02', 'media accepted: wire body {type:image, image:{link, caption rendered from variables}}; Inbox row content_type image with media_url and caption')
  })

  it('N03/N04/N05: definitive refusals fail the run and leave no Inbox trace; invalid numbers send nothing', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('undeliverable')
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'failed', error_code: 'undeliverable', attempt: 1 })
    expect(await inbox(f.conversationId)).toHaveLength(0)
    expect(t.requests).toHaveLength(1)
    pass('N03', 'Meta 131026 -> effect failed (code kept), run failed/effect_failed, 1 request (no retry), nothing in the Inbox')

    const g = await flows(); const t2 = new MockMetaTransport()
    const bad = { runs: h.newStore(), effects: h.newEffectStore(), sender: createMetaEffectSender({ transport: t2, resolveContext: async () => ({ ok: true, phoneNumberId: '1', accessToken: TOKEN, recipientPhone: 'not a phone' }) }) }
    expect(await go(bad, g.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'failed', error_code: 'invalid_recipient' })
    expect(t2.requests).toHaveLength(0)
    expect(await inbox(g.conversationId)).toHaveLength(0)
    pass('N04', 'invalid recipient number: rejected before any HTTP request; effect failed/invalid_recipient; nothing in the Inbox')

    const k = await flows(); const t3 = new MockMetaTransport().script('refused_before_send', 'refused_before_send', 'refused_before_send')
    expect(await go(proc(t3), k.runId, 'w1')).toMatchObject({ kind: 'send_deferred' })
    expect((await effects(k.runId))[0]).toMatchObject({ state: 'pending' })
    expect(t3.delivered).toHaveLength(0)
    const healthy = new MockMetaTransport()
    expect(await go(proc(healthy), k.runId, 'w2')).toMatchObject({ kind: 'completed' })
    expect(healthy.delivered).toHaveLength(1); expect(await inbox(k.conversationId)).toHaveLength(1)
    pass('N05', 'connection refused before transmission (proven unsent): retried boundedly then deferred with the effect pending; a healthy transport later delivered once and the Inbox has one row')
  })

  it('N06/N07/N08: timeouts, lost responses and disconnections are ambiguous: no resend, no Inbox row', async () => {
    const summary: string[] = []
    for (const [label, behavior] of [['timeout after acceptance', 'accept_then_timeout'], ['lost response', 'lost_response'], ['disconnection in flight', 'reset_in_flight']] as const) {
      const f = await flows(); const t = new MockMetaTransport().script(behavior)
      expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
      for (let i = 0; i < 2; i++) expect(await go(proc(t), f.runId, `again-${i}`)).toMatchObject({ kind: 'awaiting_effect_resolution' })
      expect(t.requests, label).toHaveLength(1)
      expect((await effects(f.runId))[0]).toMatchObject({ state: 'ambiguous', attempt: 1 })
      expect(await inbox(f.conversationId), label).toHaveLength(0)
      expect(await h.run(f.runId)).toMatchObject({ status: 'active', versioned_messages_executed: 0 })
      summary.push(`${label}: delivered=${t.delivered.length}`)
    }
    pass('N06', 'timeout after acceptance: ambiguous, the run waits, 3 invocations made 1 HTTP request, nothing in the Inbox (a message is not shown as sent on a guess)')
    pass('N07', 'lost response (socket hang up) after the request left: same, ambiguous and not resent')
    pass('N08', `disconnection in flight: ambiguous and not resent (${summary.join('; ')})`)
  })

  it('N09/N10: recipient variants only after a safe rejection; an ambiguous variant stops the attempt', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('not_allowed', 'accept')
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(2); expect(t.requests[0].to).not.toBe(t.requests[1].to)
    expect(t.delivered).toHaveLength(1)
    expect(await inbox(f.conversationId)).toHaveLength(1)
    expect((await effects(f.runId))).toHaveLength(1)
    pass('N09', 'first variant refused with 131030, second accepted: 2 requests, 1 delivery, still ONE effect and ONE Inbox row')
    const g = await flows(); const t2 = new MockMetaTransport().script('not_allowed', 'accept_then_timeout', 'accept')
    expect(await go(proc(t2), g.runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t2.requests).toHaveLength(2)
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'ambiguous', error_code: 'transport_timeout@v1' })
    expect(await inbox(g.conversationId)).toHaveLength(0)
    pass('N10', 'second variant ambiguous: the attempt stopped (no third request), the variant is kept in the error code (transport_timeout@v1) for reconciliation, nothing in the Inbox')
  })

  it('N11/N12: confirming twice and resolving by evidence never duplicate the Inbox message', async () => {
    const f = await flows(); const t = new MockMetaTransport()
    await go(proc(t), f.runId, 'w1')
    const again = await go(proc(t), f.runId, 'w2')
    expect(again).toMatchObject({ kind: 'not_active', status: 'completed' })
    expect(t.requests).toHaveLength(1); expect(await inbox(f.conversationId)).toHaveLength(1); expect(await links(f.runId)).toHaveLength(1)
    const [e] = await effects(f.runId)
    const p = proc(t)
    const acct = await h.account()
    expect(await p.effects.settleEffect({ accountId: acct, runId: f.runId, owner: 'x', fencingToken: 1, effectId: e.id, attemptId: e.attempt_id, outcome: 'confirmed', providerMessageId: t.wamids[0] })).toMatchObject({ settled: false })
    pass('N11', 'running the completed run again and re-confirming the effect changed nothing: 1 HTTP request, 1 Inbox row, 1 link')

    // an ambiguous effect resolved by evidence (the wamid from a status webhook) creates the message exactly once
    const g = await flows(); const t2 = new MockMetaTransport().script('accept_then_timeout')
    await go(proc(t2), g.runId, 'w1')
    const [eg] = await effects(g.runId)
    const q = proc(t2)
    const res = await resolveAmbiguousEffect(q.runs, q.effects, { accountId: acct, runId: g.runId, owner: 'operator', effectId: eg.id, resolution: 'confirmed', evidence: 'synthetic status webhook carried the wamid of this attempt', providerMessageId: t2.wamids[0] })
    expect(res).toMatchObject({ resolved: true, state: 'confirmed' })
    expect(await inbox(g.conversationId)).toHaveLength(1)
    expect((await inbox(g.conversationId))[0]).toMatchObject({ message_id: t2.wamids[0], status: 'sent' })
    expect(await go(proc(t2), g.runId, 'w2')).toMatchObject({ kind: 'completed' })
    expect(t2.requests).toHaveLength(1); expect(await inbox(g.conversationId)).toHaveLength(1)
    pass('N12', 'ambiguous effect confirmed by evidence: the Inbox row appears once (status sent), the run advanced WITHOUT another HTTP request')
  })

  it('N13/N14: process death between acceptance and persistence is recovered without resending', async () => {
    const cases = [
      { id: 'after the provider accepted, before settle', target: { method: 'settleEffect', when: 'before' as const }, delivered: 1 },
      { id: 'after settle, before the advance', target: { method: 'settleEffect', when: 'after' as const }, delivered: 1 },
    ]
    for (const c of cases) {
      const f = await flows(); const t = new MockMetaTransport()
      await expect(go(dying(t, c.target), f.runId, 'p1')).rejects.toThrow(/process is gone|simulated crash/)
      expect(t.delivered).toHaveLength(c.delivered)
      const mid = await inbox(f.conversationId)
      await h.expireLease(f.runId)
      let out = await go(proc(t), f.runId, 'p2', { recoverExpiredLease: true })
      if (c.target.when === 'before') {
        expect(mid).toHaveLength(0)                                               // accepted by the provider, unknown to us: not shown as sent
        expect(out).toMatchObject({ kind: 'awaiting_effect_resolution' })
        const q = proc(t); const [e] = await effects(f.runId)
        expect(await resolveAmbiguousEffect(q.runs, q.effects, { accountId: await h.account(), runId: f.runId, owner: 'operator', effectId: e.id, resolution: 'confirmed', evidence: 'synthetic status webhook with the wamid', providerMessageId: t.wamids[0], recoverExpiredLease: true })).toMatchObject({ resolved: true })
        out = await go(proc(t), f.runId, 'p3')
      } else {
        expect(mid).toHaveLength(1)                                               // confirmation and Inbox row are one transaction
      }
      expect(out).toMatchObject({ kind: 'completed' })
      expect(t.requests, c.id).toHaveLength(1)
      expect(await inbox(f.conversationId), c.id).toHaveLength(1)
      expect(await links(f.runId), c.id).toHaveLength(1)
    }
    pass('N13', 'death after the provider accepted but before settle: nothing in the Inbox, successor recovered to ambiguous (no resend), evidence with the wamid confirmed it: ONE HTTP request, ONE Inbox row')
    pass('N14', 'death after settle: the Inbox row already existed (same transaction as the confirmation); successor advanced without sending: ONE HTTP request, ONE row')
  })

  it('N15/N16: concurrent workers and a stale worker', async () => {
    const A = h.id(), B = h.id(), C = h.id()
    await h.synth(C, [start('cstart', 'cmsg'), msg('cmsg', 'C', 'cend'), end('cend')], 'cstart')
    await h.synth(B, [start('bstart', 'bmsg'), msg('bmsg', 'B', 'bcall'), call('bcall', C, 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'am'), msg('am', 'A', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    const r = await convRun(A, ++seq)
    const t = new MockMetaTransport()
    const [x, y] = await Promise.all([go(proc(t), r.runId, 'racer-a'), go(proc(t), r.runId, 'racer-b')])
    expect([x.kind, y.kind].filter((k) => k === 'completed')).toHaveLength(1)
    expect(t.requests).toHaveLength(3); expect(t.delivered).toHaveLength(3)
    const rows = await inbox(r.conversationId)
    expect(rows.map((m) => m.content_text)).toEqual(['A', 'B', 'C'])
    expect(new Set(rows.map((m) => m.message_id)).size).toBe(3)
    expect(await links(r.runId)).toHaveLength(3)
    pass('N15', `two interpreters racing over 3 messages ended as [${[x.kind, y.kind].sort().join(', ')}]: exactly 3 HTTP requests and 3 Inbox rows in program order, one link per effect`)

    const f = await flows(); const t2 = new MockMetaTransport()
    const runs = h.newStore(); const acct = await h.account()
    t2.onPost = async () => { await h.expireLease(f.runId); await runs.reclaimLease(acct, f.runId, 'thief', 600) }
    expect(await go(proc(t2), f.runId, 'w1')).toMatchObject({ kind: 'lease_lost' })
    expect(t2.delivered).toHaveLength(1)
    expect(await inbox(f.conversationId)).toHaveLength(0)
    expect((await effects(f.runId))[0].state).toBe('claimed')
    await h.expireLease(f.runId)
    expect(await go(proc(t2), f.runId, 'w3', { recoverExpiredLease: true })).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t2.requests).toHaveLength(1); expect(await inbox(f.conversationId)).toHaveLength(0)
    pass('N16', 'stale fencing: the worker whose lease was taken while the request was in flight could not confirm or persist anything (lease_lost, no Inbox row); the next holder recovered it to ambiguous and sent nothing')
  })

  it('N17/N18: isolation, legacy runs and the absence of network and real credentials', async () => {
    const f = await flows(); const t = new MockMetaTransport()
    const p = proc(t)
    expect(await runVersionedFlow(p.runs, { accountId: '99999999-0000-4000-8000-000000000000', runId: f.runId, owner: 'w', messaging: { effects: p.effects, sender: p.sender } })).toMatchObject({ kind: 'not_found' })
    const acct = await h.account()
    const legacy = await h.psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key) values ('50000000-0000-4000-8000-000000000002','${acct}','${h.USER}',public.qa_new_contact(${2_000_000 + Math.floor(Math.random() * 900_000)}),'active','start') returning id`)
    const snap = JSON.stringify(await h.run(legacy))
    expect(await go(p, legacy, 'w')).toMatchObject({ kind: 'not_found' })
    expect(JSON.stringify(await h.run(legacy))).toBe(snap)
    expect(t.requests).toHaveLength(0); expect(await inbox(f.conversationId)).toHaveLength(0)
    pass('N17', 'another account and a legacy run: not_found, no HTTP request, no Inbox row, legacy row byte-identical')

    // run everything once more and prove the token and message bodies never reached any persisted or logged place
    const g = await flows(); const t2 = new MockMetaTransport().script('accept_then_timeout')
    events.length = 0
    const out = await go(proc(t2), g.runId, 'w1')
    const persisted = JSON.stringify([await effects(g.runId), await h.events(g.runId), await h.psql.rows(`select error_code, resolution_evidence from public.flow_run_effects where flow_run_id='${g.runId}'`), events, out])
    expect(persisted).not.toContain(TOKEN)
    expect(JSON.stringify(await h.events(g.runId))).not.toContain('Hola Ana')
    expect(JSON.stringify(events)).not.toContain('Hola Ana')
    expect(fetchTrap).not.toHaveBeenCalled()
    pass('N18', 'global fetch trapped and never called; the synthetic token appears in no effect row, event, log or outcome; message text appears in no event or log (only in the ledger request and the Inbox row)')
  })
})
