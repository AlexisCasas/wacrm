/**
 * Contacts "Filter by time" on contacts.created_at (never updated_at / last_message_at).
 *
 * resolveTimeRange turns the chosen option into a half-open window [from, to) that the list query applies server-side
 * (`created_at >= from` and `created_at < to`). `now` is injected so the result is deterministic and testable; the page
 * resolves it when the user picks the option (not on every render) and keeps the ISO strings in state.
 */
export const TIME_FILTERS = ['all', 'today', 'last7', 'last30', 'last60', 'last90', 'older30', 'older60', 'older90', 'custom'] as const
export type TimeFilter = (typeof TIME_FILTERS)[number]

export type TimeRange = { from: string | null; to: string | null }
export type TimeRangeResult = { ok: true; range: TimeRange } | { ok: false; reason: 'incomplete' | 'invalid_range' }

const DAY_MS = 24 * 60 * 60 * 1000
const NONE: TimeRange = { from: null, to: null }

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** "YYYY-MM-DD" (the value of <input type="date">) as a local calendar day; null when it is not a real date. */
export function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
}

export function resolveTimeRange(filter: TimeFilter, now: Date, customFrom = '', customTo = ''): TimeRangeResult {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString()
  switch (filter) {
    case 'all': return { ok: true, range: NONE }
    case 'today': return { ok: true, range: { from: startOfLocalDay(now).toISOString(), to: null } }
    case 'last7': return { ok: true, range: { from: ago(7), to: null } }
    case 'last30': return { ok: true, range: { from: ago(30), to: null } }
    case 'last60': return { ok: true, range: { from: ago(60), to: null } }
    case 'last90': return { ok: true, range: { from: ago(90), to: null } }
    case 'older30': return { ok: true, range: { from: null, to: ago(30) } }
    case 'older60': return { ok: true, range: { from: null, to: ago(60) } }
    case 'older90': return { ok: true, range: { from: null, to: ago(90) } }
    case 'custom': {
      const from = customFrom ? parseLocalDate(customFrom) : null
      const to = customTo ? parseLocalDate(customTo) : null
      if ((customFrom && !from) || (customTo && !to)) return { ok: false, reason: 'incomplete' }
      if (!from && !to) return { ok: false, reason: 'incomplete' }
      if (from && to && from.getTime() > to.getTime()) return { ok: false, reason: 'invalid_range' }
      // "Hasta" is inclusive: the window ends at the start of the following local day.
      const toExclusive = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : null
      return { ok: true, range: { from: from ? from.toISOString() : null, to: toExclusive ? toExclusive.toISOString() : null } }
    }
  }
}

export function isTimeFilterActive(range: TimeRange): boolean {
  return range.from !== null || range.to !== null
}
