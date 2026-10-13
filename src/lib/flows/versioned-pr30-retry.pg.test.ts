import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKit, pass } from './test-support/pr30-kit'
import { MockMetaTransport } from './test-support/mock-meta-transport'

/**
 * PR #30 audit fix — P2 temporary rejections (HTTP 429). Isolated PostgreSQL 17 (migrations 001..062) with a scripted HTTP transport; skipped
 * unless QA_PG_CONTAINER is set. No network (global fetch is trapped) and only a synthetic credential. Ids R09-R20.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 240_000 })

describe.skipIf(!container)('PR #30: P2 temporary rejections (HTTP 429)', () => {
  const kit = createKit(container ?? '')
  const { h, proc, go, flows, inbox, effects, links, dying } = kit
  let trap: ReturnType<typeof kit.trapNetwork>
  beforeAll(async () => { trap = kit.trapNetwork() })
  afterAll(async () => { const calls = trap.mock.calls.length; vi.unstubAllGlobals(); expect(calls).toBe(0) })

  it('R09/R10/R11: HTTP 429 defers instead of failing; no loop; Retry-After and backoff', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = '120'
    const out = await go(proc(t), f.runId, 'w1')
    expect(out).toMatchObject({ kind: 'effect_retry_scheduled', attempts: 1 })
    expect(t.requests).toHaveLength(1)
    const [eff] = await effects(f.runId)
    expect(eff).toMatchObject({ state: 'pending', attempt: 1, attempt_id: null, claimed_owner: null, error_code: 'rate_limited', provider_message_id: null })
    const wait = await kit.secondsUntilRetry(f.runId)
    expect(wait).toBeGreaterThan(110); expect(wait).toBeLessThanOrEqual(121)
    const run = await h.run(f.runId)
    expect(run).toMatchObject({ status: 'active', versioned_node_key: 'bmsg', versioned_depth: 1, versioned_messages_executed: 0, versioned_nodes_executed: 3, versioned_revision: 3, end_reason: null })
    expect(await inbox(f.conversationId)).toHaveLength(0); expect(await links(f.runId)).toHaveLength(0)
    const ev = (await h.events(f.runId)).filter((e) => e.event_type === 'effect_deferred')
    expect(ev).toHaveLength(1); expect(ev[0].payload).toMatchObject({ wait_seconds: 120, wait_source: 'retry_after', attempt: 1 })
    pass('R09', 'HTTP 429 + Retry-After 120: effect back to pending with a persisted retry time (~120 s), run still ACTIVE at the message node, nothing failed, no Inbox row, message budget 0, revision unchanged, 1 request')
    const before = (await effects(f.runId))[0].retry_not_before
    for (let i = 0; i < 3; i++) expect(await go(proc(t), f.runId, `again-${i}`)).toMatchObject({ kind: 'effect_retry_scheduled' })
    expect(t.requests).toHaveLength(1)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'pending', attempt: 1, retry_not_before: before })
    expect((await h.events(f.runId)).filter((e) => e.event_type === 'effect_claimed')).toHaveLength(1)
    pass('R10', 'three more invocations before the time: all report effect_retry_scheduled, 0 new requests, no new claim, the persisted time is unchanged (no immediate retry loop)')
    // no Retry-After: backoff 30 s, then 60 s
    const g = await flows(); const t2 = new MockMetaTransport().script('rate_limited', 'rate_limited')
    await go(proc(t2), g.runId, 'w1')
    expect(await kit.secondsUntilRetry(g.runId)).toBeGreaterThan(25); expect(await kit.secondsUntilRetry(g.runId)).toBeLessThanOrEqual(31)
    await kit.makeDue(g.runId)
    expect(await go(proc(t2), g.runId, 'w2')).toMatchObject({ kind: 'effect_retry_scheduled', attempts: 2 })
    expect(await kit.secondsUntilRetry(g.runId)).toBeGreaterThan(55); expect(await kit.secondsUntilRetry(g.runId)).toBeLessThanOrEqual(61)
    expect((await h.events(g.runId)).filter((e) => e.event_type === 'effect_deferred').map((e) => [e.payload.wait_seconds, e.payload.wait_source])).toEqual([[30, 'backoff'], [60, 'backoff']])
    expect(t2.requests).toHaveLength(2)
    pass('R11', 'HTTP 429 without Retry-After: backoff 30 s, then 60 s (persisted, attempt-based); each retry made exactly one request')
  })

  it('R12/R13/R14: 5xx and timeouts stay ambiguous; HTTP 400 stays definitive', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('server_error')
    expect(await go(proc(t), f.runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(await go(proc(t), f.runId, 'w2')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t.requests).toHaveLength(1)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'ambiguous', error_code: 'http_500', retry_not_before: null })
    pass('R12', 'HTTP 500: ambiguous, the run is blocked, no resend over repeated invocations, no retry time set')
    const g = await flows(); const t2 = new MockMetaTransport().script('accept_then_timeout')
    expect(await go(proc(t2), g.runId, 'w1')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t2.requests).toHaveLength(1); expect((await effects(g.runId))[0]).toMatchObject({ state: 'ambiguous', retry_not_before: null })
    expect(await inbox(g.conversationId)).toHaveLength(0)
    pass('R13', 'timeout after acceptance: ambiguous, never deferred, never resent, nothing in the Inbox')
    const k = await flows(); const t3 = new MockMetaTransport().script('invalid_param')
    expect(await go(proc(t3), k.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect((await effects(k.runId))[0]).toMatchObject({ state: 'failed', error_code: 'meta_100', retry_not_before: null })
    expect(await h.run(k.runId)).toMatchObject({ status: 'failed' }); expect(t3.requests).toHaveLength(1)
    pass('R14', 'HTTP 400: definitive: effect failed/meta_100, run failed, no deferral and a single request')
  })

  it('R15/R16: resuming after the allowed time sends once, consumes the budget once and reaches the Inbox once', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('rate_limited', 'rate_limited', 'accept'); t.retryAfterHeader = '90'
    await go(proc(t), f.runId, 'w1')
    await kit.makeDue(f.runId)
    expect(await go(proc(t), f.runId, 'w2')).toMatchObject({ kind: 'effect_retry_scheduled', attempts: 2 })
    await kit.makeDue(f.runId)
    expect(await go(proc(t), f.runId, 'w3')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(3); expect(t.delivered).toHaveLength(1)
    const [eff] = await effects(f.runId)
    expect(eff).toMatchObject({ state: 'confirmed', attempt: 3, provider_message_id: t.wamids[0], retry_not_before: null })
    expect(await h.run(f.runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 1, versioned_nodes_executed: 6 })
    expect(await inbox(f.conversationId)).toHaveLength(1); expect(await links(f.runId)).toHaveLength(1)
    const types = (await h.events(f.runId)).map((e) => e.event_type)
    expect(types.filter((x) => x === 'effect_deferred')).toHaveLength(2); expect(types.filter((x) => x === 'effect_claimed')).toHaveLength(3)
    pass('R15', 'two 429s then accepted: 3 attempts, 1 delivery, effect confirmed, run completed with exactly 1 message of budget and 6 nodes (no double consumption), 1 Inbox row, 2 deferral events')
    const g = await flows(); const t2 = new MockMetaTransport().script('rate_limited'); t2.retryAfterHeader = '60'
    await go(proc(t2), g.runId, 'w1')
    expect(await go(proc(t2), g.runId, 'w2')).toMatchObject({ kind: 'effect_retry_scheduled' })      // fresh process objects, same persisted time
    expect(t2.requests).toHaveLength(1)
    await kit.makeDue(g.runId)
    expect(await go(proc(t2), g.runId, 'w3')).toMatchObject({ kind: 'completed' })
    expect(t2.requests).toHaveLength(2)
    pass('R16', 'a brand-new process still honours the persisted time (refused before it, proceeds after it)')
  })

  it('R17/R18: death around the deferral and a 429 followed by an ambiguous answer', async () => {
    // dies right AFTER the deferral was recorded: the successor is still held back, then proceeds
    const f = await flows(); const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = '300'
    await expect(go(dying(t, { method: 'deferEffect', when: 'after' }), f.runId, 'p1')).rejects.toThrow(/process is gone|simulated crash/)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'pending', attempt: 1 })
    await h.expireLease(f.runId)
    expect(await go(proc(t), f.runId, 'p2', { recoverExpiredLease: true })).toMatchObject({ kind: 'effect_retry_scheduled' })
    expect(t.requests).toHaveLength(1)
    await kit.makeDue(f.runId)
    expect(await go(proc(t), f.runId, 'p3')).toMatchObject({ kind: 'completed' })
    expect(t.requests).toHaveLength(2); expect(t.delivered).toHaveLength(1)
    // dies right BEFORE the deferral is recorded: the claim is abandoned -> ambiguous, never resent
    const g = await flows(); const t2 = new MockMetaTransport().script('rate_limited')
    await expect(go(dying(t2, { method: 'deferEffect', when: 'before' }), g.runId, 'p1')).rejects.toThrow(/process is gone|simulated crash/)
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'claimed', attempt: 1 })
    await h.expireLease(g.runId)
    expect(await go(proc(t2), g.runId, 'p2', { recoverExpiredLease: true })).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t2.requests).toHaveLength(1); expect((await effects(g.runId))[0]).toMatchObject({ state: 'ambiguous' })
    pass('R17', 'death after recording the deferral: successor refused until the time, then sent once; death BEFORE recording it: the claim is recovered as ambiguous and NOT resent (1 request)')
    // a 429 first, then an ambiguous answer on the retry: blocked for good
    const k = await flows(); const t3 = new MockMetaTransport().script('rate_limited', 'accept_then_timeout', 'accept'); t3.retryAfterHeader = '30'
    await go(proc(t3), k.runId, 'w1'); await kit.makeDue(k.runId)
    expect(await go(proc(t3), k.runId, 'w2')).toMatchObject({ kind: 'awaiting_effect_resolution' })
    for (let i = 0; i < 3; i++) expect(await go(proc(t3), k.runId, `again-${i}`)).toMatchObject({ kind: 'awaiting_effect_resolution' })
    expect(t3.requests).toHaveLength(2); expect(t3.delivered).toHaveLength(1)
    expect((await effects(k.runId))[0]).toMatchObject({ state: 'ambiguous', attempt: 2 })
    expect(await inbox(k.conversationId)).toHaveLength(0)
    pass('R18', '429 then a timeout on the retry: ambiguous and blocked, never resent (2 requests in total across repeated invocations), nothing in the Inbox')
  })

  it('R19/R20: concurrent workers when the retry is due; exhaustion of the attempt cap', async () => {
    const f = await flows(); const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = '30'
    await go(proc(t), f.runId, 'w1'); await kit.makeDue(f.runId)
    const [a, b] = await Promise.all([go(proc(t), f.runId, 'racer-a'), go(proc(t), f.runId, 'racer-b')])
    expect([a.kind, b.kind].filter((k) => k === 'completed')).toHaveLength(1)
    expect(t.requests).toHaveLength(2); expect(t.delivered).toHaveLength(1)
    expect((await effects(f.runId))[0]).toMatchObject({ state: 'confirmed', attempt: 2 })
    expect(await inbox(f.conversationId)).toHaveLength(1)
    expect(await h.run(f.runId)).toMatchObject({ status: 'completed', versioned_messages_executed: 1 })
    pass('R19', `two interpreters racing at the due time ended as [${[a.kind, b.kind].sort().join(', ')}]: exactly one request for the retry (2 in total), attempt 2, 1 Inbox row, 1 message of budget`)
    const g = await flows(); const t2 = new MockMetaTransport().setDefault('rate_limited'); t2.retryAfterHeader = '30'
    expect(await go(proc(t2), g.runId, 'w1', {}, { maxRetryableAttempts: 2 })).toMatchObject({ kind: 'effect_retry_scheduled', attempts: 1 })
    await kit.makeDue(g.runId)
    expect(await go(proc(t2), g.runId, 'w2', {}, { maxRetryableAttempts: 2 })).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    expect(t2.requests).toHaveLength(2)
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'failed', error_code: 'rate_limit_exhausted', attempt: 2 })
    expect(await h.run(g.runId)).toMatchObject({ status: 'failed', versioned_messages_executed: 0 })
    expect(await inbox(g.conversationId)).toHaveLength(0)
    pass('R20', 'with a cap of 2 attempts the second 429 fails the effect as rate_limit_exhausted (run failed, no Inbox row, no budget) instead of waiting forever')
  })

  // -------------------------------------------- audit round 2, case 1: throttle codes on 5xx / 408 stay ambiguous
  it('R21/R22: a throttle code on HTTP 500 / 503 / 408 is ambiguous and never resent; on a definitive 4xx it is temporary', async () => {
    const summary: string[] = []
    for (const behavior of ['throttle_code_500', 'throttle_code_503', 'throttle_code_408'] as const) {
      const f = await flows(); const t = new MockMetaTransport().script(behavior); t.retryAfterHeader = '45'
      expect(await go(proc(t), f.runId, 'w1'), behavior).toMatchObject({ kind: 'awaiting_effect_resolution' })
      for (let i = 0; i < 3; i++) expect(await go(proc(t), f.runId, `again-${i}`), behavior).toMatchObject({ kind: 'awaiting_effect_resolution' })
      expect(t.requests, behavior).toHaveLength(1)                                     // never resent
      const [eff] = await effects(f.runId)
      expect(eff, behavior).toMatchObject({ state: 'ambiguous', attempt: 1, retry_not_before: null, provider_message_id: null })
      expect((await h.events(f.runId)).filter((e) => e.event_type === 'effect_deferred'), behavior).toHaveLength(0)
      expect(await inbox(f.conversationId), behavior).toHaveLength(0)
      expect(await h.run(f.runId), behavior).toMatchObject({ status: 'active', versioned_messages_executed: 0, versioned_node_key: 'bmsg' })
      summary.push(`${behavior}: ${eff.error_code}`)
    }
    pass('R21', `throttle codes (131056 / 80007 / 130429) on HTTP 500, 503 and 408 stay ambiguous even with a Retry-After header: 1 request each across 4 invocations, no retry time, no deferral event, no Inbox row, run blocked (${summary.join('; ')})`)
    // on a definitive 4xx verdict the same codes are a temporary rejection, and other 4xx remain definitive
    const g = await flows(); const t2 = new MockMetaTransport().script('throttle_code_403')
    expect(await go(proc(t2), g.runId, 'w1')).toMatchObject({ kind: 'effect_retry_scheduled' })
    expect((await effects(g.runId))[0]).toMatchObject({ state: 'pending', attempt: 1 })
    expect(await kit.secondsUntilRetry(g.runId)).toBeGreaterThan(25)
    const k = await flows(); const t3 = new MockMetaTransport().script('throttled_400')
    expect(await go(proc(t3), k.runId, 'w1')).toMatchObject({ kind: 'effect_retry_scheduled' })
    const m = await flows(); const t4 = new MockMetaTransport().script('invalid_param')
    expect(await go(proc(t4), m.runId, 'w1')).toMatchObject({ kind: 'failed', reason: 'effect_failed' })
    pass('R22', 'a throttle code on 403 / 400 and plain HTTP 429 remain temporary rejections (deferred with a persisted time); an unrelated 400 stays definitive')
  })
})
