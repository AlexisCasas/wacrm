import { describe, expect, it } from 'vitest'
import { FakeSheet } from './fake-sheet'
import { HEADERS, rowFingerprint } from './layout'
import { runApiCheck, syntheticOrders } from './real-api-check'

describe('real-API check logic (dry run on the in-memory sheet)', () => {
  it('passes every step and leaves exactly one row per synthetic line', async () => {
    const sheet = new FakeSheet(); const r = await runApiCheck(sheet, 'S'.repeat(30), 'Registro de pedidos', { runId: 'r1' })
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([['layout', true], ['write+read', true], ['idempotent re-run', true], ['ambiguous write + retry', true], ['reconciliation', true]])
    expect(r.expected).toEqual({ orders: 4, lines: 5, units: 8, cents: 49500 }); expect(sheet.data).toHaveLength(5)
  })
  it('every synthetic row carries the fingerprint of ITS OWN content (regression: the name was changed after hashing)', () => {
    const run = syntheticOrders('abcdef12-0000'), all = [...run.main.flat(), ...run.ambiguous]
    expect(all).toHaveLength(5)
    for (const l of all) expect(l.cells[HEADERS.indexOf('Hash de fila')]).toBe(rowFingerprint(l.cells))
    expect(String(all[0].cells[HEADERS.indexOf('Nombre completo')])).toContain('abcdef12')
  })
  it('a row whose content changed no longer matches its stored fingerprint', () => {
    const l = syntheticOrders('r').main[0][0], cells = [...l.cells]; cells[HEADERS.indexOf('Vendedor')] = 'Otro'
    expect(rowFingerprint(cells)).not.toBe(l.cells[HEADERS.indexOf('Hash de fila')])
  })
  it('stops at the layout step when headers differ', async () => {
    const sheet = new FakeSheet(); sheet.header[0] = 'X'
    const r = await runApiCheck(sheet, 'S'.repeat(30), 't'); expect(r.ok).toBe(false); expect(r.steps).toHaveLength(1); expect(sheet.data).toHaveLength(0)
  })
  it('two consecutive runs on the same tab do not interfere (each run reconciles only its own rows)', async () => {
    const sheet = new FakeSheet(); await runApiCheck(sheet, 'S'.repeat(30), 't', { runId: 'r2' })
    const r2 = await runApiCheck(sheet, 'S'.repeat(30), 't', { runId: 'r3' })
    expect(r2.ok).toBe(true); expect(sheet.data).toHaveLength(10)
  })
})
