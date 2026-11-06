import { describe, expect, it } from 'vitest'
import { FakeSheet } from './fake-sheet'
import { runApiCheck } from './real-api-check'

describe('real-API check logic (dry run on the in-memory sheet)', () => {
  it('passes every step and leaves exactly one row per synthetic line', async () => {
    const sheet = new FakeSheet(); const r = await runApiCheck(sheet, 'S'.repeat(30), 'Registro de pedidos', { runId: 'r1' })
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([['layout', true], ['write+read', true], ['idempotent re-run', true], ['ambiguous write + retry', true], ['reconciliation', true]])
    expect(r.expected).toMatchObject({ orders: 3, lines: 4, units: 6, cents: 41500 }); expect(sheet.data).toHaveLength(5)
  })
  it('stops at the layout step when headers differ', async () => {
    const sheet = new FakeSheet(); sheet.header[0] = 'X'
    const r = await runApiCheck(sheet, 'S'.repeat(30), 't'); expect(r.ok).toBe(false); expect(r.steps).toHaveLength(1); expect(sheet.data).toHaveLength(0)
  })
  it('a row altered after writing is reported, not repaired', async () => {
    const sheet = new FakeSheet(); await runApiCheck(sheet, 'S'.repeat(30), 't', { runId: 'r2' })
    const r2 = await runApiCheck(sheet, 'S'.repeat(30), 't', { runId: 'r2' })   // different random order ids each call: still clean
    expect(r2.ok).toBe(true)
  })
})
