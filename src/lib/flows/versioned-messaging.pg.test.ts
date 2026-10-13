import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runVersionedFlow, type RunVersionedFlowOptions } from './versioned-interpreter'
import { resolveAmbiguousEffect, type EffectSender, type OutboundRequest } from './versioned-messaging'
import { createHarness, type NodeSpec } from './test-support/versioned-pg'
import { MockEffectSender } from './test-support/mock-sender'

/**
 * E4.2C2: send_message / send_media executed by the versioned interpreter through the effect ledger and a scripted
 * sender, against the isolated PostgreSQL 17 container (migrations 001..059). Skipped unless QA_PG_CONTAINER is set.
 * No test here can reach a network: global fetch is replaced by a trap and the sender is an in-memory double.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

describe.skipIf(!container)('E4.2C2 messaging from the interpreter (mock sender)', () => {
  const h = createHarness(container ?? '')
  const { call, start, end } = h
  const msg = (key: string, text: string, next: string): NodeSpec => ({ key, type: 'send_message', config: { text, next_node_key: next } })
  const media = (key: string, next: string, caption?: string): NodeSpec => ({ key, type: 'send_media', config: { media_type: 'image', media_url: 'https://example.test/pic.png', ...(caption ? { caption } : {}), next_node_key: next } })
  const fetchTrap = vi.fn(() => { throw new Error('network access is forbidden in these tests') })
  beforeAll(() => { vi.stubGlobal('fetch', fetchTrap) })
  afterAll(() => { vi.unstubAllGlobals() })

  type Proc = { runs: ReturnType<typeof h.newStore>; effects: ReturnType<typeof h.newEffectStore>; sender: EffectSender }
  /** A healthy process around `sender`. */
  const proc = (sender: MockEffectSender): Proc => ({ runs: h.newStore(), effects: h.newEffectStore(), sender })
  /** A process that dies at the chosen call (of the run store, the effect store, or the sender). */
  function dying(sender: MockEffectSender, target: { store: 'effects' | 'runs' | 'sender'; method: string; when: 'before' | 'after'; nth?: number }): Proc {
    const death = h.processDeath()
    const spec = (kind: string) => (target.store === kind ? { method: target.method, when: target.when, nth: target.nth } : undefined)
    return { runs: death.wrap(h.newStore(), spec('runs')), effects: death.wrap(h.newEffectStore(), spec('effects')),
      sender: death.wrap({ send: (r: OutboundRequest) => sender.send(r) }, spec('sender')) }
  }
  const go = async (p: Proc, runId: string, owner: string, extra: Partial<RunVersionedFlowOptions> = {}) =>
    runVersionedFlow(p.runs, { accountId: await h.account(), runId, owner, messaging: { effects: p.effects, sender: p.sender }, ...extra })

  /** A: start -> call(B) -> fin ; B: bstart -> bmsg -> bend */
  async function callerCallee(bNodes?: NodeSpec[]) {
    const A = h.id(), B = h.id()
    const vb = await h.synth(B, bNodes ?? [start('bstart', 'bmsg'), msg('bmsg', 'Hello {{vars.name}}', 'bend'), end('bend')], 'bstart')
    const va = await h.synth(A, [start('start', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    return { A, B, va, vb }
  }
  const effectRows = (runId: string) => h.psql.rows<Record<string, any>>(`select * from public.flow_run_effects where flow_run_id='${runId}' order by occurrence_revision`) // eslint-disable-line @typescript-eslint/no-explicit-any
  const setVars = (runId: string, vars: object) => h.psql.sql(`update public.flow_runs set vars='${JSON.stringify(vars)}' where id='${runId}'`)
  const crashAndExpire = async (runId: string) => { await h.expireLease(runId) }

  it('M01/M02/M21: A -> B.send_message -> B.END -> A and send_media, same run, variables kept, no network', async () => {
    const f = await callerCallee()
    const runId = await h.createRun(f.A)
    await setVars(runId, { name: 'Ana' })
    const sender = new MockEffectSender()
    const out = await go(proc(sender), runId, 'w1')
    expect(out).toMatchObject({ kind: 'completed', flowRunId: runId, nodesExecuted: 6 })
    const run = await h.run(runId)
    expect(run).toMatchObject({ status: 'completed', versioned_depth: 0, versioned_messages_executed: 1, versioned_nodes_executed: 6, versioned_node_key: 'fin' })
    expect(run.vars).toEqual({ name: 'Ana' })
    expect(sender.calls).toHaveLength(1); expect(sender.delivered).toHaveLength(1)
    expect(sender.calls[0].payload).toEqual({ kind: 'text', text: 'Hello Ana' })
    const [eff] = await effectRows(runId)
    expect(eff).toMatchObject({ state: 'confirmed', attempt: 1, node_key: 'bmsg', flow_version_id: f.vb, provider_message_id: sender.delivered[0].providerMessageId, occurrence_revision: 3 })
    expect(sender.calls[0]).toMatchObject({ attemptId: eff.attempt_id, occurrenceKey: `${runId}:3`, effectId: eff.id, attempt: 1 })
    expect((await h.events(runId)).map((e) => e.event_type)).toEqual(['subflow_called', 'effect_registered', 'effect_claimed', 'effect_confirmed', 'subflow_returned'])
    pass('M01', 'A->B.send_message->B.END->A: 1 send (text rendered once from the shared variables), effect confirmed with the provider id, same run completed, A.fin ran after the callee content, 6 nodes + 1 message of budget')

    const f2 = await callerCallee([start('bstart', 'pic'), media('pic', 'bend', 'For {{vars.name}}'), end('bend')])
    const run2 = await h.createRun(f2.A)
    await setVars(run2, { name: 'Luis' })
    const sender2 = new MockEffectSender()
    expect(await go(proc(sender2), run2, 'w1')).toMatchObject({ kind: 'completed' })
    expect(sender2.calls[0].payload).toEqual({ kind: 'media', media_type: 'image', media_url: 'https://example.test/pic.png', caption: 'For Luis' })
    expect(sender2.calls[0].effectType).toBe('send_media')
    expect(await h.run(run2)).toMatchObject({ status: 'completed', versioned_messages_executed: 1 })
    pass('M02', 'A->B.send_media->B.END->A: one media message with the caption rendered from variables; completed; 1 message of budget')
    expect(fetchTrap).not.toHaveBeenCalled()
    pass('M21', 'global fetch was trapped for the whole file and never called; the sender is an in-memory double')
  })

  it('M03: A -> B -> C with messages in every flow, in order, with returns after each', async () => {
    const A = h.id(), B = h.id(), C = h.id()
    await h.synth(C, [start('cstart', 'cmsg'), msg('cmsg', 'C says hi', 'cend'), end('cend')], 'cstart')
    await h.synth(B, [start('bstart', 'bmsg'), msg('bmsg', 'B says hi', 'bcall'), call('bcall', C, 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'am'), msg('am', 'A says hi', 'call'), call('call', B, 'afin'), msg('afin', 'A says bye', 'aend'), end('aend')], 'start')
    const runId = await h.createRun(A)
    const sender = new MockEffectSender()
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'completed' })
    expect(sender.texts()).toEqual(['A says hi', 'B says hi', 'C says hi', 'A says bye'])
    const run = await h.run(runId)
    expect(run).toMatchObject({ status: 'completed', versioned_depth: 0, versioned_messages_executed: 4 })
    expect(await h.frames(runId)).toEqual([])
    expect((await effectRows(runId)).map((e) => [e.node_key, e.state])).toEqual([['am', 'confirmed'], ['bmsg', 'confirmed'], ['cmsg', 'confirmed'], ['afin', 'confirmed']])
    pass('M03', 'A->B->C with 4 messages: sent in program order A, B, C, then A again after both returns; 4 confirmed effects, 4 messages of budget, no frames left, one run')
  })

  it('M04: a definitive rejection fails the run and keeps the evidence', async () => {
    const f = await callerCallee()
    const runId = await h.createRun(f.A)
    const sender = new MockEffectSender().script('permanent_failure')
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    const [eff] = await effectRows(runId)
    expect(eff).toMatchObject({ state: 'failed', error_code: 'invalid_recipient', attempt: 1, provider_message_id: null })
    expect(await h.run(runId)).toMatchObject({ status: 'failed', end_reason: 'effect_failed', versioned_depth: 1, versioned_messages_executed: 0, versioned_node_key: 'bmsg' })
    expect(await h.frames(runId)).toHaveLength(1)
    expect(sender.delivered).toHaveLength(0)
    pass('M04', 'provider rejected with certainty: effect failed (error code kept), run failed/effect_failed, cursor and call frame kept as evidence, nothing advanced and no message budget consumed')
  })

  it('M05/M06/M07: ambiguous results block the run; only evidence unblocks it', async () => {
    // M05: accepted but the answer is a timeout; a delivery receipt later confirms it
    let f = await callerCallee(); let runId = await h.createRun(f.A)
    let sender = new MockEffectSender().script('accept_then_timeout')
    const out = await go(proc(sender), runId, 'w1')
    expect(out).toMatchObject({ kind: 'awaiting_effect_resolution' })
    const [eff] = await effectRows(runId)
    expect(eff.state).toBe('ambiguous')
    expect(await h.run(runId)).toMatchObject({ status: 'active', versioned_node_key: 'bmsg', versioned_messages_executed: 0, versioned_lease_owner: null })
    const tokenAfterFirst = (await h.run(runId)).versioned_lease
    for (let i = 0; i < 3; i++) expect(await go(proc(sender), runId, `retry-${i}`)).toMatchObject({ kind: 'awaiting_effect_resolution', effectId: eff.id })
    expect(sender.calls).toHaveLength(1)
    expect((await h.run(runId)).versioned_lease).toBe(tokenAfterFirst)      // no lease churn while waiting
    const p = proc(sender)
    const resolved = await resolveAmbiguousEffect(p.runs, p.effects, { accountId: await h.account(), runId, owner: 'operator', effectId: eff.id, resolution: 'confirmed',
      evidence: 'synthetic delivery receipt matched the attempt', providerMessageId: sender.delivered[0].providerMessageId })
    expect(resolved).toMatchObject({ resolved: true, state: 'confirmed' })
    expect(await go(proc(sender), runId, 'w2')).toMatchObject({ kind: 'completed' })
    expect(sender.calls).toHaveLength(1); expect(sender.delivered).toHaveLength(1)
    expect(await h.run(runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 1 })
    pass('M05', 'timeout after acceptance: ambiguous, run blocked (awaiting_effect_resolution) with no resend over 3 further invocations and no lease churn; a synthetic receipt confirmed it and the run advanced WITHOUT sending again (1 send in total)')

    // M06: ambiguous and NOT delivered; evidence that nothing was sent re-opens it for a second attempt
    f = await callerCallee(); runId = await h.createRun(f.A)
    sender = new MockEffectSender().script('timeout_not_delivered')
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    const [e2] = await effectRows(runId)
    const p2 = proc(sender)
    expect(await resolveAmbiguousEffect(p2.runs, p2.effects, { accountId: await h.account(), runId, owner: 'operator', effectId: e2.id, resolution: 'not_sent', evidence: 'synthetic provider log: no request for this attempt' })).toMatchObject({ resolved: true, state: 'pending' })
    expect(await go(proc(sender), runId, 'w2')).toMatchObject({ kind: 'completed' })
    const [e2b] = await effectRows(runId)
    expect(e2b).toMatchObject({ state: 'confirmed', attempt: 2 })
    expect(sender.calls).toHaveLength(2); expect(sender.delivered).toHaveLength(1)
    expect(sender.calls[1].attemptId).not.toBe(sender.calls[0].attemptId)
    pass('M06', 'ambiguous but never delivered: resolved with not_sent evidence -> second attempt with a new attempt id -> exactly one delivery')

    // M07: the response is lost (the call throws) after delivery: never resent
    f = await callerCallee(); runId = await h.createRun(f.A)
    sender = new MockEffectSender().script('accept_then_lose_response')
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(await go(proc(sender), runId, 'w2')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(sender.calls).toHaveLength(1); expect(sender.delivered).toHaveLength(1)
    pass('M07', 'a sender exception after delivery (lost response) is ambiguous: no automatic second send over repeated invocations')
  })

  it('M08: only a proven not_dispatched is retried automatically, boundedly', async () => {
    let f = await callerCallee(); let runId = await h.createRun(f.A)
    let sender = new MockEffectSender().script('fail_before_send', 'fail_before_send', 'accept')
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'completed' })
    const [e] = await effectRows(runId)
    expect(e).toMatchObject({ state: 'confirmed', attempt: 3 })
    expect(sender.calls).toHaveLength(3); expect(sender.delivered).toHaveLength(1)
    const types = (await h.events(runId)).map((x) => x.event_type)
    expect(types.filter((t) => t === 'effect_claimed')).toHaveLength(3)
    expect(types.filter((t) => t === 'effect_resolved')).toHaveLength(2)
    expect(new Set(sender.calls.map((c) => c.attemptId)).size).toBe(3)
    // exhaustion: the effect goes back to pending (proven unsent) and the run waits, it is not failed
    f = await callerCallee(); runId = await h.createRun(f.A)
    sender = new MockEffectSender().script('fail_before_send', 'fail_before_send', 'fail_before_send')
    expect(await go(proc(sender), runId, 'w1', { messaging: undefined })).toMatchObject({ kind: 'failed', reason: 'unsupported_node_type:send_message' })
    f = await callerCallee(); runId = await h.createRun(f.A)
    const p = proc(sender)
    const out = await runVersionedFlow(p.runs, { accountId: await h.account(), runId, owner: 'w1', messaging: { effects: p.effects, sender: p.sender, maxNotDispatchedRetries: 1 } })
    expect(out).toMatchObject({ kind: 'send_deferred', attempts: 2 })
    expect((await effectRows(runId))[0]).toMatchObject({ state: 'pending', attempt: 2 })
    expect(await h.run(runId)).toMatchObject({ status: 'active', versioned_messages_executed: 0 })
    const healthy = new MockEffectSender()
    expect(await go(proc(healthy), runId, 'w2')).toMatchObject({ kind: 'completed' })
    expect(healthy.delivered).toHaveLength(1)
    expect((await effectRows(runId))[0]).toMatchObject({ state: 'confirmed', attempt: 3 })
    pass('M08', 'not_dispatched x2 then accepted: 3 attempts (3 distinct attempt ids), 2 evidence-based resolutions, 1 delivery; with a retry cap of 1 the run is deferred (effect pending, nothing failed) and a healthy sender later delivers exactly once; without messaging the node stays unsupported')
  })

  it('M09-M13: process death at every point of the send sequence never duplicates a message', async () => {
    const summary: string[] = []
    const cases: Array<{ id: string; target: Parameters<typeof dying>[1]; expectAfterDeath: 'pending' | 'claimed' | 'confirmed' | 'advanced'; successor: 'completes' | 'awaiting_not_sent' | 'awaiting_confirmed' }> = [
      { id: 'before claim', target: { store: 'effects', method: 'claimEffect', when: 'before' }, expectAfterDeath: 'pending', successor: 'completes' },
      { id: 'after claim', target: { store: 'effects', method: 'claimEffect', when: 'after' }, expectAfterDeath: 'claimed', successor: 'awaiting_not_sent' },
      { id: 'after acceptance', target: { store: 'effects', method: 'settleEffect', when: 'before' }, expectAfterDeath: 'claimed', successor: 'awaiting_confirmed' },
      { id: 'after settle', target: { store: 'effects', method: 'settleEffect', when: 'after' }, expectAfterDeath: 'confirmed', successor: 'completes' },
      { id: 'after commit', target: { store: 'effects', method: 'commitEffectStep', when: 'after' }, expectAfterDeath: 'advanced', successor: 'completes' },
    ]
    for (const c of cases) {
      const f = await callerCallee(); const runId = await h.createRun(f.A)
      await setVars(runId, { name: 'Eva' })
      const sender = new MockEffectSender()
      await expect(go(dying(sender, c.target), runId, 'proc-1')).rejects.toThrow(/process is gone|simulated crash/)
      const [row] = await effectRows(runId)
      const run = await h.run(runId)
      if (c.expectAfterDeath === 'advanced') { expect(row.state).toBe('confirmed'); expect(run.versioned_messages_executed).toBe(1) }
      else { expect(row.state).toBe(c.expectAfterDeath); expect(run.versioned_messages_executed).toBe(0) }
      expect(run.versioned_lease_owner).toBe('proc-1')
      await crashAndExpire(runId)
      const successor = await go(proc(sender), runId, 'proc-2', { recoverExpiredLease: true })
      if (c.successor === 'completes') {
        expect(successor).toMatchObject({ kind: 'completed' })
      } else {
        expect(successor).toMatchObject({ kind: 'awaiting_effect_resolution' })
        const p = proc(sender)
        const delivered = sender.delivered[0]
        const res = c.successor === 'awaiting_confirmed'
          ? await resolveAmbiguousEffect(p.runs, p.effects, { accountId: await h.account(), runId, owner: 'operator', effectId: row.id, resolution: 'confirmed', evidence: 'synthetic receipt for the abandoned attempt', providerMessageId: delivered.providerMessageId, recoverExpiredLease: true })
          : await resolveAmbiguousEffect(p.runs, p.effects, { accountId: await h.account(), runId, owner: 'operator', effectId: row.id, resolution: 'not_sent', evidence: 'synthetic provider log: attempt never arrived', recoverExpiredLease: true })
        expect(res).toMatchObject({ resolved: true })
        expect(await go(proc(sender), runId, 'proc-3')).toMatchObject({ kind: 'completed' })
      }
      expect(sender.delivered, c.id).toHaveLength(1)                                   // never two deliveries
      expect(sender.calls, c.id).toHaveLength(1)
      expect(await h.run(runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 1, versioned_depth: 0 })
      expect((await effectRows(runId)).filter((e) => e.state === 'confirmed')).toHaveLength(1)
      summary.push(`${c.id} -> ${c.successor}`)
    }
    pass('M09', 'death before claim: effect still pending, successor sent once')
    pass('M10', 'death after claim: nothing was sent; successor recovered the claim to ambiguous and waited; evidence "not sent" -> single delivery')
    pass('M11', 'death after acceptance (before settle): the message was delivered; successor recovered it to ambiguous and waited; a receipt confirmed it -> still a single delivery')
    pass('M12', 'death after settle: successor found the effect confirmed and advanced without sending (1 delivery)')
    pass('M13', `death after the advance commit: successor continued with the next nodes, no resend (${summary.join('; ')})`)
  })

  it('M14/M15: concurrent interpreters and a stale worker', async () => {
    const A = h.id(), B = h.id(), C = h.id()
    await h.synth(C, [start('cstart', 'cmsg'), msg('cmsg', 'C', 'cend'), end('cend')], 'cstart')
    await h.synth(B, [start('bstart', 'bmsg'), msg('bmsg', 'B', 'bcall'), call('bcall', C, 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'am'), msg('am', 'A', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    const runId = await h.createRun(A)
    const sender = new MockEffectSender()
    const [x, y] = await Promise.all([go(proc(sender), runId, 'racer-a'), go(proc(sender), runId, 'racer-b')])
    const kinds = [x.kind, y.kind].sort()
    expect(kinds.filter((k) => k === 'completed')).toHaveLength(1)
    expect(sender.delivered).toHaveLength(3); expect(sender.calls).toHaveLength(3)
    expect(sender.texts()).toEqual(['A', 'B', 'C'])
    expect(await h.run(runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 3 })
    expect((await effectRows(runId)).every((e) => e.attempt === 1 && e.state === 'confirmed')).toBe(true)
    pass('M14', `two interpreters racing over A->B->C with 3 messages ended as [${kinds.join(', ')}]; exactly 3 deliveries, every effect attempt 1`)

    // M15: the lease is taken over while the send is in flight
    const f = await callerCallee(); const run2 = await h.createRun(f.A)
    const s2 = new MockEffectSender()
    const runs = h.newStore(); const acct = await h.account()
    s2.onSend = async () => { await h.expireLease(run2); await runs.reclaimLease(acct, run2, 'thief', 600) }
    const out = await go({ runs: h.newStore(), effects: h.newEffectStore(), sender: s2 }, run2, 'w1')
    expect(out).toMatchObject({ kind: 'lease_lost' })
    expect(s2.delivered).toHaveLength(1)
    expect((await effectRows(run2))[0].state).toBe('claimed')            // the old worker could not settle or advance
    expect(await h.run(run2)).toMatchObject({ versioned_lease_owner: 'thief', versioned_messages_executed: 0, versioned_node_key: 'bmsg' })
    await h.expireLease(run2)
    expect(await go(proc(s2), run2, 'w3', { recoverExpiredLease: true })).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(s2.calls).toHaveLength(1)
    pass('M15', 'stale fencing: the worker whose lease was taken during the send could not settle or advance (lease_lost); the claim became ambiguous for the next holder, which did not resend')
  })

  it('M16: message budget 99 -> 100, and full', async () => {
    const A = h.id()
    await h.synth(A, [start('start', 'm1'), msg('m1', 'one', 'm2'), msg('m2', 'two', 'fin'), end('fin')], 'start')
    const runId = await h.createRun(A)
    await h.psql.sql(`update public.flow_runs set versioned_messages_executed=99 where id='${runId}'`)
    const sender = new MockEffectSender()
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'message_budget_exceeded' })
    expect(sender.texts()).toEqual(['one'])
    expect(await h.run(runId)).toMatchObject({ status: 'failed', versioned_messages_executed: 100, versioned_node_key: 'm2' })
    expect((await effectRows(runId)).map((e) => e.node_key)).toEqual(['m1'])                 // the second message was never registered
    const run2 = await h.createRun(A)
    await h.psql.sql(`update public.flow_runs set versioned_messages_executed=100 where id='${run2}'`)
    const s2 = new MockEffectSender()
    expect(await go(proc(s2), run2, 'w1')).toMatchObject({ kind: 'failed', reason: 'message_budget_exceeded' })
    expect(s2.calls).toHaveLength(0)
    // a recovery never consumes budget twice
    const run3 = await h.createRun(A)
    const s3 = new MockEffectSender()
    await expect(go(dying(s3, { store: 'effects', method: 'settleEffect', when: 'after' }), run3, 'p1')).rejects.toThrow()
    await h.expireLease(run3)
    expect(await go(proc(s3), run3, 'p2', { recoverExpiredLease: true })).toMatchObject({ kind: 'completed' })
    expect(await h.run(run3)).toMatchObject({ versioned_messages_executed: 2 })
    expect(s3.delivered).toHaveLength(2)
    pass('M16', 'budget 99: the 100th message sent and consumed it, the 101st refused before registration (0 sends); budget 100: refused immediately; a death after settle + recovery consumed exactly one message of budget per effect (2 messages, 2 budget)')
  })

  it('M17/M18: the same node twice, republication and the pinned payload', async () => {
    // M17: B is called twice by A (sequentially, so not recursion); same node_key, same text, two legitimate sends
    const A = h.id(), B = h.id()
    await h.synth(B, [start('bstart', 'bmsg'), msg('bmsg', 'same text', 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'c1'), call('c1', B, 'c2'), call('c2', B, 'fin'), end('fin')], 'start')
    const runId = await h.createRun(A)
    const sender = new MockEffectSender()
    expect(await go(proc(sender), runId, 'w1')).toMatchObject({ kind: 'completed' })
    const rows = await effectRows(runId)
    expect(rows).toHaveLength(2)
    expect(rows[0].node_key).toBe(rows[1].node_key)
    expect(rows[0].occurrence_revision).not.toBe(rows[1].occurrence_revision)
    expect(sender.delivered).toHaveLength(2)
    expect(await h.run(runId)).toMatchObject({ versioned_messages_executed: 2, status: 'completed' })
    pass('M17', `B.bmsg executed twice in one run (revisions ${rows[0].occurrence_revision} and ${rows[1].occurrence_revision}) with an identical payload: two effects, two deliveries, 2 messages of budget`)

    // M18a: B is republished with a different text while the run sits before B.bmsg
    const f = await callerCallee()
    const run2 = await h.createRun(f.A)
    await setVars(run2, { name: 'Zoe' })
    const s2 = new MockEffectSender()
    await go(proc(s2), run2, 'w1', { maxSteps: 3 })        // start, call, bstart -> cursor at bmsg, nothing sent yet
    expect(await h.run(run2)).toMatchObject({ versioned_node_key: 'bmsg', versioned_depth: 1 })
    await h.synth(f.B, [start('bstart', 'bmsg'), msg('bmsg', 'REPUBLISHED {{vars.name}}', 'bend'), end('bend')], 'bstart')
    expect(await go(proc(s2), run2, 'w1')).toMatchObject({ kind: 'completed' })
    expect(s2.texts()).toEqual(['Hello Zoe'])
    // M18b: the payload registered in the ledger wins over later changes of the variables
    const f3 = await callerCallee()
    const run3 = await h.createRun(f3.A)
    await setVars(run3, { name: 'Old' })
    const s3 = new MockEffectSender()
    await expect(go(dying(s3, { store: 'effects', method: 'claimEffect', when: 'before' }), run3, 'p1')).rejects.toThrow()
    expect((await effectRows(run3))[0]).toMatchObject({ state: 'pending', request: { kind: 'text', text: 'Hello Old' } })
    await setVars(run3, { name: 'NEW' })
    await h.expireLease(run3)
    expect(await go(proc(s3), run3, 'p2', { recoverExpiredLease: true })).toMatchObject({ kind: 'completed' })
    expect(s3.texts()).toEqual(['Hello Old'])
    pass('M18', 'republished callee does not change the pinned snapshot text; after a crash between registration and send, the stored payload ("Hello Old") is sent even though the variable changed to NEW')
  })

  it('M22: a claim that belongs to someone else is never sent, even when recovery cannot classify it', async () => {
    // recover (run at the start of every invocation) only abandons claims of OLDER fencing tokens. A claim that shows up
    // later under the CURRENT token but another owner is a corrupt ledger: the interpreter must refuse, not send.
    const f = await callerCallee(); const runId = await h.createRun(f.A)
    const sender = new MockEffectSender()
    await expect(go(dying(sender, { store: 'effects', method: 'claimEffect', when: 'before' }), runId, 'p1')).rejects.toThrow()
    expect((await effectRows(runId))[0].state).toBe('pending')
    await h.expireLease(runId)
    const real = h.newEffectStore()
    let planted = false
    const seeded = { ...real, recoverEffects: async (c: Parameters<typeof real.recoverEffects>[0]) => {
      const r = await real.recoverEffects(c)
      if (planted) return r
      planted = true
      await h.psql.sql(`update public.flow_run_effects set state='claimed', attempt=attempt+1, attempt_id=gen_random_uuid(), claimed_owner='ghost', claimed_fencing_token=${c.fencingToken}, claimed_at=now() where flow_run_id='${runId}'`)
      return r
    } }
    const out = await go({ runs: h.newStore(), effects: seeded, sender }, runId, 'p2', { recoverExpiredLease: true })
    expect(out).toMatchObject({ kind: 'corrupt_checkpoint' })
    expect(sender.calls).toHaveLength(0)
    expect((await effectRows(runId))[0]).toMatchObject({ state: 'claimed', claimed_owner: 'ghost' })
    pass('M22', 'an effect claimed by a foreign owner under the current token (not an older lease) is refused as corrupt: the sender was never called')
  })

  it('M19/M20: other accounts, legacy runs and the opt-in of messaging', async () => {
    const f = await callerCallee(); const runId = await h.createRun(f.A)
    const sender = new MockEffectSender()
    const p = proc(sender)
    const foreign = await runVersionedFlow(p.runs, { accountId: '99999999-0000-4000-8000-000000000000', runId, owner: 'w', messaging: { effects: p.effects, sender: p.sender } })
    expect(foreign).toMatchObject({ kind: 'not_found' })
    const acct = await h.account()
    const legacy = await h.psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key) values ('50000000-0000-4000-8000-000000000002','${acct}','${h.USER}',public.qa_new_contact(${989000 + Math.floor(Math.random() * 9000)}),'active','start') returning id`)
    const snap = JSON.stringify(await h.run(legacy))
    expect(await go(p, legacy, 'w')).toMatchObject({ kind: 'not_found' })
    expect(JSON.stringify(await h.run(legacy))).toBe(snap)
    expect(sender.calls).toHaveLength(0)
    expect(await effectRows(runId)).toEqual([])
    expect(await h.psql.sql(`select count(*) from public.flow_run_effects where flow_run_id='${legacy}'`)).toBe('0')
    pass('M19', 'another account and a legacy run are not_found: the sender was never called, no ledger row exists, the legacy row is byte-identical')
    const bare = await runVersionedFlow(h.newStore(), { accountId: acct, runId, owner: 'w' })
    expect(bare).toMatchObject({ kind: 'failed', reason: 'unsupported_node_type:send_message' })
    pass('M20', 'without the messaging option the interpreter keeps B2.2 behaviour: message nodes end the run as unsupported_node_type, nothing is registered')
  })
})
