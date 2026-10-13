import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createSupabaseEffectStore, effectOccurrenceKey, isSafeToSend, type EffectState } from './versioned-effects'
import { VersionedStoreError } from './versioned-store'

const caller = { accountId: 'a', runId: 'r', owner: 'w', fencingToken: 3 }
const client = (rpc: (fn: string, args: Record<string, unknown>) => unknown) => ({ rpc: async (fn: string, args: Record<string, unknown>) => rpc(fn, args) }) as unknown as SupabaseClient

describe('effect identity and resend rule', () => {
  it('keys an occurrence by run and revision', () => {
    expect(effectOccurrenceKey('run-1', 4)).toBe('run-1:4')
    expect(effectOccurrenceKey('run-1', 4)).not.toBe(effectOccurrenceKey('run-1', 6))
  })
  it.each<[EffectState, boolean]>([['pending', true], ['claimed', false], ['ambiguous', false], ['confirmed', false], ['failed', false]])('isSafeToSend(%s) = %s', (state, safe) => {
    expect(isSafeToSend(state)).toBe(safe)
  })
})

describe('createSupabaseEffectStore', () => {
  it('maps register arguments and PostgREST rows', async () => {
    const rpc = vi.fn(() => ({ data: [{ registered: true, effect_id: 'e1', effect_state: 'pending', effect_revision: '7', reason: null }], error: null }))
    const s = createSupabaseEffectStore(client(rpc))
    expect(await s.registerEffect({ ...caller, expectedRevision: 7, effectType: 'send_message', request: { text: 'hi' } })).toEqual({ registered: true, effectId: 'e1', state: 'pending', occurrenceRevision: 7, reason: null })
    expect(rpc).toHaveBeenCalledWith('register_versioned_effect', { p_account_id: 'a', p_run_id: 'r', p_owner: 'w', p_fencing_token: 3, p_expected_revision: 7, p_effect_type: 'send_message', p_request: { text: 'hi' } })
  })
  it('maps claim, settle, resolve and step', async () => {
    const answers: Record<string, unknown> = {
      claim_versioned_effect: [{ claimed: true, effect_state: 'claimed', attempt_no: 1, claimed_attempt_id: 'att', reason: null }],
      settle_versioned_effect: [{ settled: false, effect_state: 'claimed', reason: 'attempt_mismatch' }],
      resolve_versioned_effect: [{ resolved: true, effect_state: 'pending', reason: null }],
      commit_versioned_effect_step: [{ committed: true, revision: 9, reason: null, nodes_executed: 4, messages_executed: 2 }],
    }
    const rpc = vi.fn((fn: string) => ({ data: answers[fn], error: null }))
    const s = createSupabaseEffectStore(client(rpc))
    expect(await s.claimEffect(caller, 'e1')).toEqual({ claimed: true, state: 'claimed', attempt: 1, attemptId: 'att', reason: null })
    expect(await s.settleEffect({ ...caller, effectId: 'e1', attemptId: 'att', outcome: 'confirmed', providerMessageId: 'wamid.1' })).toEqual({ settled: false, state: 'claimed', reason: 'attempt_mismatch' })
    expect(rpc).toHaveBeenCalledWith('settle_versioned_effect', expect.objectContaining({ p_outcome: 'confirmed', p_provider_message_id: 'wamid.1', p_error_code: null }))
    expect(await s.resolveEffect({ ...caller, effectId: 'e1', resolution: 'not_sent', evidence: 'provider log' })).toEqual({ resolved: true, state: 'pending', reason: null })
    expect(await s.commitEffectStep({ ...caller, expectedRevision: 8, effectId: 'e1', checkpoint: { c: 1 } })).toEqual({ committed: true, revision: 9, nodesExecuted: 4, messagesExecuted: 2, reason: null })
  })
  it('recoverEffects returns changed effects or the lease refusal', async () => {
    const some = createSupabaseEffectStore(client(() => ({ data: [{ effect_id: 'e1', previous_state: 'claimed', new_state: 'ambiguous', reason: null }], error: null })))
    expect(await some.recoverEffects(caller)).toEqual({ recovered: [{ effectId: 'e1', previousState: 'claimed', newState: 'ambiguous' }], refusal: null })
    const none = createSupabaseEffectStore(client(() => ({ data: [], error: null })))
    expect(await none.recoverEffects(caller)).toEqual({ recovered: [], refusal: null })
    const gated = createSupabaseEffectStore(client(() => ({ data: [{ effect_id: null, previous_state: null, new_state: null, reason: 'stale_lease' }], error: null })))
    expect(await gated.recoverEffects(caller)).toEqual({ recovered: [], refusal: 'stale_lease' })
  })
  it('raises typed errors for SQL errors and malformed responses', async () => {
    const err = createSupabaseEffectStore(client(() => ({ data: null, error: { code: 'P0002', message: 'versioned effect not found' } })))
    await expect(err.claimEffect(caller, 'e1')).rejects.toMatchObject({ name: 'VersionedStoreError', code: 'P0002' })
    for (const data of [[], null, [{ claimed: 'yes' }]]) {
      const bad = createSupabaseEffectStore(client(() => ({ data, error: null })))
      await expect(bad.claimEffect(caller, 'e1')).rejects.toBeInstanceOf(VersionedStoreError)
    }
  })
})

describe('isolation from production code', () => {
  it('the effect ledger module is only used by sibling versioned-* modules and sends nothing', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || p.includes('/test-support/') || name === 'versioned-effects.ts') continue
        // sibling internal modules of the versioned runtime (interpreter, messaging) may use it; routes, dispatchers and cron may not
        if (/^versioned-[a-z-]+\.ts$/.test(name) && p.includes('/src/lib/flows/')) continue
        if (/versioned-effects['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
    const src = readFileSync(join(process.cwd(), 'src/lib/flows/versioned-effects.ts'), 'utf8')
    expect(src).not.toMatch(/fetch\(|graph\.facebook|meta-send|send-message/)
  })
})
