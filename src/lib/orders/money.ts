// One shared price validator, used by legacy and multiproduct orders.
// Preserve previous currency syntax and rounding rules.
export function normalizePrice(raw: unknown): string | null {
  const s = typeof raw === 'number' ? String(raw) : text(raw).replace(',', '.')
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const whole = m[1].replace(/^0+(?=\d)/, '')
  const fraction = (m[2] ?? '').padEnd(2, '0')
  if (Number(whole) === 0 && Number(fraction) === 0) return null
  return `${whole}.${fraction}`
}
