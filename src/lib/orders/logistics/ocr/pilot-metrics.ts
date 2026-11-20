import { nameTokens, normalizeDni, normalizePhone } from '@/lib/orders/logistics/normalize'

// Pure scoring for the controlled OCR pilot (30-50 real vouchers, run OFFLINE by a person; see docs/operations/P0-OCR-PILOT-PLAN.md). It compares what the provider read
// with the manually captured ground truth. No I/O, no provider call: the pilot runner only feeds records in. Nothing here validates a voucher.

export const PILOT_FIELDS = ['customer_name', 'dni', 'phone', 'amount', 'shalom_number', 'shalom_code', 'destination'] as const
export type PilotField = (typeof PILOT_FIELDS)[number]

export interface PilotRecord {
  /** Manual capture (the ground truth). null = the field is genuinely absent on the voucher. */
  truth: Partial<Record<PilotField, string | null>>
  /** What the provider returned (already normalized by normalizeOcrOutput); undefined when the attempt failed. */
  ocr?: Partial<Record<PilotField, { value: string | null; confidence: number }>>
  errorCode?: string | null
  ms?: number
  /** The order the matching rule picked (null = left pending) and the order a person says is right. */
  matchedOrder?: string | null
  trueOrder?: string | null
  costUsd?: number
}

const digits = (v: string) => v.replace(/\D+/g, '')
const alnum = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '')

/**
 * The numeric value of an amount, ignoring ONLY monetary presentation: a leading currency marker (S/, S/., PEN, USD, $), spaces and thousands separators.
 * "S/ 150.00", "S/150.00", "150.00" and "150" are the same value; anything that is not a plain number afterwards (letters, two decimal marks...) is not comparable (null).
 * Values are compared in cents, so 150.5 and 150.50 match and 150.51 does not.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/^(?:S\/\.?|PEN|USD|\$)\s*/i, '').replace(/\s+/g, '')
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '') // 1,150.00
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.') // 150,50 / 1.150,50
  else s = s.replace(/,/g, '') // 1,150
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null
  return Math.round(Number.parseFloat(s) * 100)
}

/** Field-aware equality: DNI / phone / amount / ids compare in their canonical form; names compare as the same word set. */
export function fieldEquals(field: PilotField, a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  switch (field) {
    case 'dni': return normalizeDni(a) !== null && normalizeDni(a) === normalizeDni(b)
    case 'phone': return normalizePhone(a) !== null && normalizePhone(a) === normalizePhone(b)
    case 'amount': {
      const x = parseAmount(a)
      const y = parseAmount(b)
      return x !== null && y !== null && x === y
    }
    case 'shalom_number': return digits(a) === digits(b)
    case 'shalom_code': return alnum(a) === alnum(b)
    default: {
      const x = nameTokens(a).sort().join(' ')
      const y = nameTokens(b).sort().join(' ')
      return x !== '' && x === y
    }
  }
}

export interface PilotConfig {
  /** A read below this confidence is a "doubtful" field and forces human review (and never feeds the matching rule). */
  reviewThreshold: number
}
export const INITIAL_PILOT_CONFIG: PilotConfig = { reviewThreshold: 0.9 }

export interface FieldStats { total: number; correct: number; accuracy: number; falsePositives: number; falsePositiveRate: number; doubtful: number; doubtfulRate: number; missed: number }
export interface PilotReport {
  vouchers: number
  failed: number
  failedByCode: Record<string, number>
  fields: Record<PilotField, FieldStats>
  /** Vouchers with at least one doubtful / wrong / missing field, or a failed attempt: a person must look closely (validation is ALWAYS human anyway). */
  needReviewRate: number
  /** Vouchers read with no doubtful and no wrong field: the only ones a reviewer could confirm at a glance. */
  cleanRate: number
  meanMs: number | null
  matching: { attempted: number; autoMatched: number; autoCorrect: number; autoWrong: number; pending: number; correctRate: number }
  totalCostUsd: number
  /** Mean over the vouchers whose usage was reported; null when none was. */
  costPerVoucherUsd: number | null
  /** Answered vouchers whose provider reported no token usage (reported as usage_unavailable; NEVER a failure and never invented). */
  usageUnavailable: number
}

export function scorePilot(records: readonly PilotRecord[], config: PilotConfig = INITIAL_PILOT_CONFIG): PilotReport {
  const fields = Object.fromEntries(PILOT_FIELDS.map((f) => [f, { total: 0, correct: 0, accuracy: 0, falsePositives: 0, falsePositiveRate: 0, doubtful: 0, doubtfulRate: 0, missed: 0 }])) as Record<PilotField, FieldStats>
  const failedByCode: Record<string, number> = {}
  let failed = 0
  let needReview = 0
  let clean = 0
  const times: number[] = []
  let cost = 0
  let costed = 0
  let usageUnavailable = 0
  const matching = { attempted: 0, autoMatched: 0, autoCorrect: 0, autoWrong: 0, pending: 0, correctRate: 0 }

  for (const r of records) {
    if (typeof r.costUsd === 'number') {
      cost += r.costUsd
      costed += 1
    } else if (r.ocr) usageUnavailable += 1
    if (typeof r.ms === 'number') times.push(r.ms)
    if (!r.ocr) {
      failed += 1
      const code = r.errorCode ?? 'unknown'
      failedByCode[code] = (failedByCode[code] ?? 0) + 1
      needReview += 1 // a failed attempt ALWAYS goes to manual review
      continue
    }
    let flagged = false
    for (const f of PILOT_FIELDS) {
      if (!(f in r.truth)) continue
      const s = fields[f]
      const truth = r.truth[f] ?? null
      const read = r.ocr[f]
      const value = read?.value ?? null
      const conf = read?.confidence ?? 0
      s.total += 1
      const ok = fieldEquals(f, value, truth)
      if (ok) s.correct += 1
      if (truth && !value) s.missed += 1
      const doubtful = value !== null && conf < config.reviewThreshold
      if (doubtful) s.doubtful += 1
      // FALSE POSITIVE: a wrong (or invented) value the provider was confident about: the dangerous case.
      if (!ok && value !== null && conf >= config.reviewThreshold) s.falsePositives += 1
      if (doubtful || !ok) flagged = true
    }
    if (flagged) needReview += 1
    else clean += 1

    if (r.trueOrder !== undefined || r.matchedOrder !== undefined) {
      matching.attempted += 1
      if (r.matchedOrder) {
        matching.autoMatched += 1
        if (r.matchedOrder === r.trueOrder) matching.autoCorrect += 1
        else matching.autoWrong += 1
      } else matching.pending += 1
    }
  }
  for (const f of PILOT_FIELDS) {
    const s = fields[f]
    s.accuracy = s.total ? s.correct / s.total : 0
    s.falsePositiveRate = s.total ? s.falsePositives / s.total : 0
    s.doubtfulRate = s.total ? s.doubtful / s.total : 0
  }
  matching.correctRate = matching.autoMatched ? matching.autoCorrect / matching.autoMatched : 0
  return {
    vouchers: records.length,
    failed,
    failedByCode,
    fields,
    needReviewRate: records.length ? needReview / records.length : 0,
    cleanRate: records.length ? clean / records.length : 0,
    meanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    matching,
    totalCostUsd: cost,
    costPerVoucherUsd: costed > 0 ? cost / costed : null,
    usageUnavailable,
  }
}

/** Sweep thresholds to pick the one with 0 confident-wrong reads and the lowest review load. */
export function sweepThresholds(records: readonly PilotRecord[], thresholds: readonly number[] = [0.7, 0.8, 0.85, 0.9, 0.95]) {
  return thresholds.map((t) => {
    const rep = scorePilot(records, { reviewThreshold: t })
    const falsePositives = PILOT_FIELDS.reduce((n, f) => n + rep.fields[f].falsePositives, 0)
    return { threshold: t, falsePositives, needReviewRate: rep.needReviewRate, cleanRate: rep.cleanRate }
  })
}
