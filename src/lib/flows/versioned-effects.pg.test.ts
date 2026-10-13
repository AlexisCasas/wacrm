import { describe, expect, it, vi } from 'vitest'
import { createSupabaseEffectStore, effectOccurrenceKey, isSafeToSend } from './versioned-effects'
import { createHarness } from './test-support/versioned-pg'

/**
 * E4.2C1: the typed effect-ledger store against the isolated PostgreSQL container (migrations 001..059).
 * Skipped unless QA_PG_CONTAINER is set. Nothing here talks to a provider.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 120_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

describe.skipIf(!container)('E4.2C1 effect ledger through the typed store', () => {
  const h = createHarness(container ?? '')
  const runs = h.newStore()
  async function flow() {
    const F = h.id()
    const v = await h.synth(F, [{ key: 'm', type: 'send_message', config: { text: 'hi', next_node_key: 'x' } }, h.end('x')], 'm')
    return { F, v }
  }
  async function leasedRun(F: string, owner = 'w1') {
    const runId = await h.createRun(F)
    const acct = await h.account()
    const lease = await runs.acquireLease(acct, runId, owner, 600)
    return { runId, acct, token: lease.fencingToken }
  }

  it('E23: register -> claim -> settle -> advance, with PostgREST-shaped responses', async () => {
    const { F, v } = await flow()
    const { runId, acct, token } = await leasedRun(F)
    const effects = createSupabaseEffectStore((await import('./test-support/psql-client')).createPsqlSupabaseClient(h.psql))
    const c = { accountId: acct, runId, owner: 'w1', fencingToken: token }
    const reg = await effects.registerEffect({ ...c, expectedRevision: 0, effectType: 'send_message', request: { text: 'hello' } })
    expect(reg).toMatchObject({ registered: true, state: 'pending', occurrenceRevision: 0, reason: null })
    expect(await effects.registerEffect({ ...c, expectedRevision: 0, effectType: 'send_message', request: { text: 'hello' } })).toMatchObject({ registered: false, effectId: reg.effectId, reason: 'already_registered' })
    expect(isSafeToSend(reg.state!)).toBe(true)
    const claim = await effects.claimEffect(c, reg.effectId!)
    expect(claim).toMatchObject({ claimed: true, state: 'claimed', attempt: 1 })
    expect(claim.attemptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(isSafeToSend('claimed')).toBe(false)
    expect(await effects.settleEffect({ ...c, effectId: reg.effectId!, attemptId: claim.attemptId!, outcome: 'confirmed', providerMessageId: 'wamid.NODE1' })).toEqual({ settled: true, state: 'confirmed', reason: null })
    const step = await effects.commitEffectStep({ ...c, expectedRevision: 0, effectId: reg.effectId!, checkpoint: { cursor: { flow_version_id: v, node_key: 'x' }, step: 1 } })
    expect(step).toMatchObject({ committed: true, revision: 1, nodesExecuted: 1, messagesExecuted: 1, reason: null })
    expect(await effects.commitEffectStep({ ...c, expectedRevision: 0, effectId: reg.effectId!, checkpoint: { cursor: { flow_version_id: v, node_key: 'x' }, step: 1 } })).toMatchObject({ committed: false, reason: 'revision_conflict', messagesExecuted: 1 })
    const run = await h.run(runId)
    expect(run).toMatchObject({ versioned_revision: 1, versioned_messages_executed: 1, versioned_node_key: 'x', status: 'active' })
    expect(effectOccurrenceKey(runId, reg.occurrenceRevision)).toBe(`${runId}:0`)
    pass('E23', 'typed store round trip: pending -> claimed(attempt 1) -> confirmed -> step (revision 1, 1 node + 1 message); replay -> revision_conflict with the budget still 1; occurrence key run:revision')
  })

  it('E24: recovery through the typed store never re-opens an ambiguous effect without evidence', async () => {
    const { F } = await flow()
    const { runId, acct, token } = await leasedRun(F, 'w1')
    const effects = createSupabaseEffectStore((await import('./test-support/psql-client')).createPsqlSupabaseClient(h.psql))
    const c1 = { accountId: acct, runId, owner: 'w1', fencingToken: token }
    const reg = await effects.registerEffect({ ...c1, expectedRevision: 0, effectType: 'send_message', request: { text: 'hello' } })
    const first = await effects.claimEffect(c1, reg.effectId!)
    // w1 dies after the claim; its lease lapses and w2 takes over
    await h.expireLease(runId)
    const lease2 = await runs.reclaimLease(acct, runId, 'w2', 600)
    expect(lease2).toMatchObject({ acquired: true, fencingToken: token + 1 })
    const c2 = { accountId: acct, runId, owner: 'w2', fencingToken: lease2.fencingToken }
    expect(await effects.settleEffect({ ...c1, effectId: reg.effectId!, attemptId: first.attemptId!, outcome: 'confirmed', providerMessageId: 'wamid.LATE' })).toMatchObject({ settled: false, reason: 'stale_lease' })
    const rec = await effects.recoverEffects(c2)
    expect(rec).toEqual({ recovered: [{ effectId: reg.effectId, previousState: 'claimed', newState: 'ambiguous' }], refusal: null })
    expect(await effects.recoverEffects(c2)).toEqual({ recovered: [], refusal: null })
    expect(isSafeToSend('ambiguous')).toBe(false)
    expect(await effects.claimEffect(c2, reg.effectId!)).toMatchObject({ claimed: false, state: 'ambiguous', reason: 'effect_not_pending' })
    expect(await effects.recoverEffects(c1)).toMatchObject({ refusal: 'stale_lease' })
    // evidence that nothing was sent: a NEW attempt with a NEW attempt id
    expect(await effects.resolveEffect({ ...c2, effectId: reg.effectId!, resolution: 'not_sent', evidence: 'provider has no request for attempt 1' })).toEqual({ resolved: true, state: 'pending', reason: null })
    const second = await effects.claimEffect(c2, reg.effectId!)
    expect(second).toMatchObject({ claimed: true, attempt: 2 })
    expect(second.attemptId).not.toBe(first.attemptId)
    const events = (await h.events(runId)).map((e) => e.event_type)
    expect(events).toEqual(['effect_registered', 'effect_claimed', 'effect_ambiguous', 'effect_resolved', 'effect_claimed'])
    expect(JSON.stringify(await h.events(runId))).not.toContain('hello')
    pass('E24', 'old worker refused; successor recovered the abandoned claim to ambiguous (idempotent), could not claim it, re-opened it only with explicit not_sent evidence, attempt 2 got a new attempt id; the trace holds no message body')
  })
})
