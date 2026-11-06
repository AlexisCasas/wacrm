import { KEY_COLUMN_INDEX, compareRow, type Cell, type ProjectedLine } from './layout'

// Index the sheet by row key: first row seen per key, and how many rows carry each key.
export function indexRows(rows: Cell[][]): { first: Map<string, Cell[]>; count: Map<string, number> } {
  const first = new Map<string, Cell[]>(), count = new Map<string, number>()
  for (const r of rows) {
    const k = String(r[KEY_COLUMN_INDEX] ?? '')
    if (!k) continue
    if (!first.has(k)) first.set(k, r)
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  return { first, count }
}

// Pure planning step shared by the worker's logic and the real-API check: which projected lines are missing, which exist unchanged, which exist ALTERED.
export function planLines(rows: Cell[][], lines: ProjectedLine[]): { missing: ProjectedLine[]; present: ProjectedLine[]; altered: { key: string; columns: string[] }[]; duplicated: string[] } {
  const idx = indexRows(rows)
  const missing: ProjectedLine[] = [], present: ProjectedLine[] = [], altered: { key: string; columns: string[] }[] = [], duplicated: string[] = []
  for (const l of lines) {
    const row = idx.first.get(l.key)
    if (!row) { missing.push(l); continue }
    if ((idx.count.get(l.key) ?? 0) > 1) duplicated.push(l.key)
    const columns = compareRow(l.cells, row)
    if (columns.length) altered.push({ key: l.key, columns }); else present.push(l)
  }
  return { missing, present, altered, duplicated }
}
