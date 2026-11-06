import { describe, expect, it } from 'vitest'
import { FakeSheet } from './fake-sheet'
import { controlWrites, limaNowSerial, publishControl, CONTROL_TAB } from './control'
import { limaSerial } from './layout'
import type { ReconcileReport } from './reconcile'

const report = (o: Partial<ReconcileReport> = {}): ReconcileReport => ({
  eligibleOrders: 224, eligibleLines: 225, eligibleUnits: 258, eligibleCents: 3125500, sheetOrders: 224, sheetLines: 225, sheetUnits: 258, sheetCents: 3125500,
  missingKeys: [], extraKeys: [], duplicateKeys: [], orderAmountMismatches: [], lineMismatches: [], contentMismatches: [], projectionErrors: [],
  excludedOrders: 2, excludedByReason: { test: 2 }, notAcknowledgedOrders: 2, beforeEligibleSince: 0, jobsByStatus: { exported: 224, excluded: 2 }, differences: 0, ...o,
})

describe('control tab publishing', () => {
  it('writes DB and sheet figures side by side, counters, and the timestamp last', async () => {
    const sheet = new FakeSheet(); const now = Date.parse('2026-11-06T19:30:00Z')
    await publishControl(sheet, 'S'.repeat(30), report({ duplicateKeys: ['k'], contentMismatches: ['k2:Producto'] }), now)
    expect(sheet.written.map((w) => w.a1)).toEqual(['C2:D7', 'C13:C15', 'B9'])
    expect(sheet.written.every((w) => w.tab === CONTROL_TAB)).toBe(true)
    expect(sheet.written[0].values).toEqual([[224, 224], [225, 225], [258, 258], [31255, 31255], [0, 1], [0, 1]])
    expect(sheet.written[1].values).toEqual([[2], [2], [0]])
    expect(sheet.written[2].values[0][0]).toBeCloseTo(limaSerial('2026-11-06T19:30:00Z').dateTime, 6)
  })
  it('if a write fails the timestamp is NOT refreshed (the sheet will report the pass as stale)', async () => {
    const sheet = new FakeSheet(); sheet.failWrite = true
    await expect(publishControl(sheet, 'S'.repeat(30), report(), Date.now())).rejects.toBeDefined()
    expect(sheet.written).toHaveLength(0)
  })
  it('Lima serial matches the register serial for the same instant', () => {
    const t = Date.parse('2026-11-04T15:30:05Z')
    expect(limaNowSerial(t)).toBeCloseTo(limaSerial('2026-11-04T15:30:05Z').dateTime, 8)
  })
  it('dead jobs and test exclusions are reported as counters, not guessed', () => {
    const w = controlWrites(report({ jobsByStatus: { dead: 3 }, excludedByReason: {} }), 0)
    expect(w[2].values).toEqual([[0], [2], [3]])
  })
})
