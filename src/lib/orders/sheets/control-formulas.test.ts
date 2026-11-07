import { describe, expect, it } from 'vitest'
import { FakeSheet } from './fake-sheet'
import { CONTROL_FORMULA_SPEC, applyControlFormulas, controlFormulaWrites, modelStatus, type StatusInputs } from './control-formulas'
import { CONTROL_TAB } from './control'

const base: StatusInputs = { lastPassSerial: 100, nowSerial: 100.02, maxAgeHours: 1.5, deadJobs: 0, serverDiffs: [0, 0, 0, 0, 0, 0], liveDuplicates: 0, growth: [0, 0, 0, 0] }
const s = (o: Partial<StatusInputs>) => modelStatus({ ...base, ...o })

describe('control tab status (reference model of the sheet formula)', () => {
  it('no pass yet / pass too old / dead jobs win over everything else', () => {
    expect(s({ lastPassSerial: null })).toBe('SIN CONCILIAR')
    expect(s({ nowSerial: 100 + 1.6 / 24 })).toBe('CONCILIACIÓN VENCIDA')
    expect(s({ deadJobs: 1, growth: [1, 1, 1, 10] })).toBe('TRABAJOS EN ERROR')
  })
  it('«Sin diferencias» only when the live sheet still equals what the last pass saw', () => {
    expect(s({})).toBe('Sin diferencias')
    expect(s({ growth: [1, 2, 3, 150.5] })).toBe('PENDIENTE DE CONCILIAR')          // legitimate new orders after the last pass
    expect(s({ growth: [0, 1, 1, 50] })).toBe('PENDIENTE DE CONCILIAR')
  })
  it('shrinkage, a live duplicate or a server-found difference is a real difference, never «pending»', () => {
    expect(s({ growth: [-1, -1, -1, -10] })).toBe('HAY DIFERENCIAS')
    expect(s({ growth: [1, 1, 2, -5] })).toBe('HAY DIFERENCIAS')                       // growth in counts but the amount went down: not just growth
    expect(s({ liveDuplicates: 1, growth: [1, 1, 1, 10] })).toBe('HAY DIFERENCIAS')
    expect(s({ serverDiffs: [0, 0, 0, 0, 0, 2] })).toBe('HAY DIFERENCIAS')
    expect(s({ serverDiffs: [1, 0, 0, 0, 0, 0], growth: [1, 1, 1, 10] })).toBe('HAY DIFERENCIAS')
  })
})

describe('control formulas spec', () => {
  const cells = Object.fromEntries(CONTROL_FORMULA_SPEC.cells.map((c) => [c.a1, c]))
  it('targets only the cells meant for it and never the server-written ones (C2:D7, B9, C13:C15)', () => {
    const forbidden = /^(C[2-7]|D[2-7]|B9|C1[3-5])$/
    expect(CONTROL_FORMULA_SPEC.cells.map((c) => c.a1).filter((a) => forbidden.test(a))).toEqual([])
    expect(Object.keys(cells).sort()).toEqual(['A11', 'A12', 'B10', 'B11', 'B12', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'])
  })
  it('the status formula uses the same four tiers as the model and compares the LIVE column B with column D', () => {
    const f = cells.B10.formula!
    for (const t of ['SIN CONCILIAR', 'CONCILIACIÓN VENCIDA', 'TRABAJOS EN ERROR', 'HAY DIFERENCIAS', 'PENDIENTE DE CONCILIAR', 'Sin diferencias']) expect(f).toContain(t)
    expect(f).toContain('F2:F4'); expect(f).toContain('B6>0'); expect(f).toContain('B11/24')
    for (const r of [2, 3, 4, 5, 6]) expect(cells[`F${r}`].formula).toContain(`B${r}-D${r}`)
  })
  it('vigencia is 1.5 h: three missed 30-minute passes at most', () => { expect(cells.B11.value).toBe(1.5) })
  it('writes through the formula path (USER_ENTERED), never the RAW path used for the figures', async () => {
    const sheet = new FakeSheet()
    expect(await applyControlFormulas(sheet, 'S'.repeat(30))).toBe(CONTROL_FORMULA_SPEC.cells.length)
    expect(sheet.written).toHaveLength(0); expect(sheet.formulaWrites).toHaveLength(CONTROL_FORMULA_SPEC.cells.length)
    expect(sheet.formulaWrites.every((w) => w.tab === CONTROL_TAB)).toBe(true)
    expect(controlFormulaWrites().find((w) => w.a1 === 'B10')!.values[0][0]).toMatch(/^=IF\(B9=""/)
  })
})
