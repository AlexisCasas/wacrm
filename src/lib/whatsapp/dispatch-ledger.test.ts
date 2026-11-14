import { describe, expect, it, vi } from 'vitest'
import { ledgerBegin, ledgerClaim, ledgerRun, type LedgerClaim, type StepState } from './dispatch-ledger'

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code: string } | null }>
const dbWith = (rpc: Rpc) => ({ rpc: vi.fn(rpc) }) as unknown as import('@supabase/supabase-js').SupabaseClient & { rpc: ReturnType<typeof vi.fn> }
const claim = (steps: Partial<Record<string, StepState>>, flowConsumed: boolean | null = null): LedgerClaim => ({
  outcome: 'claimed', token: 'tok', isFirstInbound: true, contactCreated: false, flowConsumed, attempts: 1,
  steps: { flows: 'pending', automations: 'pending', ai: 'pending', webhook: 'pending', ...steps } as LedgerClaim['steps'],
})
const ok = (data: unknown = true) => Promise.resolve({ data, error: null })

describe('dispatch ledger: availability', () => {
  it('begin degrades to "off" (previous behaviour) when the RPC fails or answers nonsense', async () => {
    expect(await ledgerBegin(dbWith(() => Promise.resolve({ data: null, error: { code: '42883' } })), 'a', 'w', true, false)).toBe('off')
    expect(await ledgerBegin(dbWith(() => ok('x')), 'a', 'w', true, false)).toBe('off')
    expect(await ledgerBegin(dbWith(() => ok(true)), 'a', 'w', true, false)).toBe('created')
    expect(await ledgerBegin(dbWith(() => ok(false)), 'a', 'w', true, false)).toBe('existed')
  })
  it('claim returns null when unavailable and maps the row otherwise', async () => {
    expect(await ledgerClaim(dbWith(() => Promise.resolve({ data: null, error: { code: 'x' } })), 'a', 'w')).toBeNull()
    const row = { outcome: 'busy', token: null, steps: {}, is_first_inbound: true, contact_created: true, flow_consumed: null, attempts: 2 }
    expect(await ledgerClaim(dbWith(() => ok([row])), 'a', 'w')).toMatchObject({ outcome: 'busy', isFirstInbound: true, contactCreated: true, flowConsumed: null, attempts: 2 })
  })
})

describe('dispatch ledger: step rules', () => {
  const run = (steps: Partial<Record<string, StepState>>, trace: boolean | null = null) => {
    const calls: string[] = []
    const db = dbWith((name, args) => {
      calls.push(name === 'inbound_dispatch_step' ? `step:${args.p_step}:${args.p_status}` : name)
      return name === 'inbound_dispatch_has_trace' ? ok(trace) : ok(true)
    })
    return { calls, runner: ledgerRun(db, 'acct', 'wamid', claim(steps), 'contact') }
  }
  it('a pending step runs once: started -> done, carrying the Flow verdict', async () => {
    const { calls, runner } = run({}); const fn = vi.fn(async () => ({ consumed: true }))
    expect(await runner.step('flows', fn, { consumedOf: (r) => r.consumed })).toMatchObject({ ran: true })
    expect(fn).toHaveBeenCalledTimes(1); expect(calls).toEqual(['step:flows:started', 'step:flows:done']); expect(runner.flowConsumed).toBe(true)
  })
  it('done / skipped / reconcile steps never run again', async () => {
    for (const s of ['done', 'skipped', 'reconcile'] as StepState[]) {
      const { calls, runner } = run({ ai: s }); const fn = vi.fn(async () => 1)
      expect((await runner.step('ai', fn)).ran).toBe(false); expect(fn).not.toHaveBeenCalled(); expect(calls).toEqual([])
    }
  })
  it('a started Flow step with NO trace in the database is safely repeated', async () => {
    const { runner } = run({ flows: 'started' }, false); const fn = vi.fn(async () => ({ consumed: false }))
    expect((await runner.step('flows', fn, { consumedOf: (r) => r.consumed })).ran).toBe(true); expect(fn).toHaveBeenCalledTimes(1)
  })
  it('a started step WITH a trace is parked for reconciliation and not repeated', async () => {
    const { calls, runner } = run({ automations: 'started' }, true); const fn = vi.fn(async () => 1)
    expect((await runner.step('automations', fn)).ran).toBe(false); expect(fn).not.toHaveBeenCalled(); expect(calls).toContain('step:automations:reconcile')
  })
  it('an unanswerable trace check (error / null) fails SAFE: reconcile, never repeat', async () => {
    const { runner } = run({ flows: 'started' }, null); const fn = vi.fn(async () => 1)
    expect((await runner.step('flows', fn)).ran).toBe(false); expect(fn).not.toHaveBeenCalled()
  })
  it('losing the lease aborts before any side effect', async () => {
    const db = dbWith((name) => ok(name === 'inbound_dispatch_step' ? false : true)); const fn = vi.fn(async () => 1)
    await expect(ledgerRun(db, 'a', 'w', claim({}), 'c').step('webhook', fn)).rejects.toThrow('dispatch_ledger_lease_lost'); expect(fn).not.toHaveBeenCalled()
  })
})
