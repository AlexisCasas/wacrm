// Normalizers shared by the voucher <-> order COMPARISON (this stage) and the bulk MATCHING rule (next stage). Pure functions, no I/O.
// DNI / phone / name / amount are matching SIGNALS only: the functional key between a voucher and its order is always order_id.

const digits = (value: string) => value.replace(/\D+/g, '')

/** Peruvian DNI: exactly 8 digits once separators are removed; anything else is not comparable. */
export function normalizeDni(value: string | null | undefined): string | null {
  if (!value) return null
  const d = digits(value)
  return d.length === 8 ? d : null
}

/** Peruvian mobile as 51XXXXXXXXX. Accepts +51 / 51 / bare 9-digit forms; anything else is not comparable. */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null
  const d = digits(value)
  if (/^51\d{9}$/.test(d)) return d
  if (/^9\d{8}$/.test(d)) return `51${d}`
  return null
}

const stripAccents = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Lowercase, accent-less, punctuation-less words (>= 2 chars). */
export function nameTokens(value: string | null | undefined): string[] {
  if (!value) return []
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

/** "S/ 1,200.50", "1.200,50", "10", "10.5" -> 1200.5 / 1200.5 / 10 / 10.5. Null when it does not look like an amount. */
export function normalizeAmount(value: string | null | undefined): number | null {
  if (!value) return null
  let s = value.replace(/[^\d.,-]/g, '')
  if (!/\d/.test(s)) return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // the later separator is the decimal one
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // a single comma followed by exactly 1-2 digits is a decimal comma; otherwise a thousands separator
    s = /,\d{1,2}$/.test(s) && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.replace(/,/g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/** Last `n` characters, everything before hidden: what a screen may show of a DNI / phone of the order. */
export const maskTail = (value: string, n = 3) => (value.length <= n ? '*'.repeat(value.length) : `${'*'.repeat(Math.min(6, value.length - n))}${value.slice(-n)}`)
