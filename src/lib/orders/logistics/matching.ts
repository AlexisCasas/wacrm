import { normalizeDni, normalizePhone } from '@/lib/orders/logistics/normalize'

// The CONSERVATIVE rule that may associate a BULK-uploaded voucher to an order. It never applies to a voucher uploaded from an order (there the
// order is known and the OCR only validates). Pure, isolated and unit-tested; every threshold lives in MATCHING_CONFIG, in code (not in data),
// so changing a number is a reviewed code change with its tests.
//
// RULE (DECISION PENDIENTE DE APROBACIÓN — implemented as the proposed default, easy to tighten):
//   Candidates are the orders of the SAME account that are still `pending_voucher`.
//   The voucher is associated automatically ONLY when ALL of these hold:
//     1. exactly ONE candidate matches at least one strong signal (DNI / phone) — if two or more candidates match any strong signal, it is ambiguous;
//     2. that candidate matches at least `minStrongSignals` DISTINCT strong signals (default 2: DNI and phone);
//     3. every signal used was read by the OCR with confidence >= `minFieldConfidence`.
//   Anything else -> PENDING ASSOCIATION with a human choice (candidates are only suggestions). Nothing is ever picked arbitrarily, and even an
//   automatic association still needs a person to VALIDATE the voucher.
//   Name and amount are NOT signals: they are informational on the review screen.

export const MATCHING_CONFIG = {
  strongSignals: ['dni', 'phone'] as const,
  minStrongSignals: 2,
  minFieldConfidence: 0.8,
} as const

export type MatchingConfig = {
  readonly strongSignals: readonly ('dni' | 'phone')[]
  readonly minStrongSignals: number
  readonly minFieldConfidence: number
}

export type StrongSignal = 'dni' | 'phone'

export interface MatchCandidateOrder {
  id: string
  dni: string | null
  phone: string
}

export type PendingReason = 'no_signals' | 'low_confidence' | 'no_candidates' | 'ambiguous' | 'insufficient_signals'

export interface MatchCandidateHint {
  orderId: string
  signals: StrongSignal[]
}

export type MatchDecision =
  | { kind: 'auto'; orderId: string; signals: StrongSignal[] }
  | { kind: 'pending'; reason: PendingReason; candidates: MatchCandidateHint[] }

type OcrFields = Record<string, { value?: string | null; confidence?: number } | undefined>

/** The strong signals the OCR read, with their normalized values. A signal below the confidence floor is reported separately, never used. */
export function extractSignals(fields: OcrFields, config: MatchingConfig = MATCHING_CONFIG): { usable: Partial<Record<StrongSignal, string>>; lowConfidence: StrongSignal[] } {
  const usable: Partial<Record<StrongSignal, string>> = {}
  const lowConfidence: StrongSignal[] = []
  for (const signal of config.strongSignals) {
    const raw = fields[signal]
    const value = signal === 'dni' ? normalizeDni(raw?.value) : normalizePhone(raw?.value)
    if (!value) continue
    if ((raw?.confidence ?? 0) >= config.minFieldConfidence) usable[signal] = value
    else lowConfidence.push(signal)
  }
  return { usable, lowConfidence }
}

export function decideMatch(fields: OcrFields, candidates: readonly MatchCandidateOrder[], config: MatchingConfig = MATCHING_CONFIG): MatchDecision {
  const { usable, lowConfidence } = extractSignals(fields, config)
  const usableSignals = Object.keys(usable) as StrongSignal[]
  if (usableSignals.length === 0) return { kind: 'pending', reason: lowConfidence.length > 0 ? 'low_confidence' : 'no_signals', candidates: [] }

  const hits: MatchCandidateHint[] = []
  for (const candidate of candidates) {
    const matched: StrongSignal[] = []
    if (usable.dni && normalizeDni(candidate.dni) === usable.dni) matched.push('dni')
    if (usable.phone && normalizePhone(candidate.phone) === usable.phone) matched.push('phone')
    if (matched.length > 0) hits.push({ orderId: candidate.id, signals: matched })
  }

  if (hits.length === 0) return { kind: 'pending', reason: 'no_candidates', candidates: [] }
  if (hits.length > 1) return { kind: 'pending', reason: 'ambiguous', candidates: hits }
  const [only] = hits
  if (only.signals.length < config.minStrongSignals) return { kind: 'pending', reason: 'insufficient_signals', candidates: hits }
  return { kind: 'auto', orderId: only.orderId, signals: only.signals }
}
