import type { ShipmentStatus } from '@/lib/orders/shalom/types'

// PR-05 · CENTRALIZED tracking configuration. EVERY number here is a DEFAULT QA / PROVISIONAL value: Shalom's real limits (rate limit, latency, volume)
// are NOT KNOWN yet and nothing below is an SLA or a production contract. They are tuned (SHALOM_CONFIG_JSON) once the real limits and the real number of
// active shipments are known. Server-side only; nothing in here is a secret.

export interface ShalomConfig {
  /** How often the cron script is meant to tick (informational: the schedule lives in the system cron). */
  tickMinutes: number
  /** Minutes between two queries of the same shipment, by its current normalized status. */
  intervalMinutes: { at_origin: number; in_transit: number; at_destination: number }
  /** Shipments claimed per tick (queried sequentially). */
  batchSize: number
  /** Time budget of ONE query to the provider. */
  timeoutMs: number
  /** A claim not finished within this many seconds can be retaken (crashed worker). */
  leaseSeconds: number
  /** Per-order backoff after a technical failure, in minutes (the last value repeats). */
  backoffMinutes: number[]
  /** An ORDER-level error (guide not found / invalid) must last this long, without a single good answer, before requires_attention. */
  attentionWindowHours: number
  /** Forced refreshes of the same order are at least this far apart. */
  refreshMinIntervalSeconds: number
  /** Calendar days (America/Lima) in En destino before the internal alert. */
  alertDays: number
  /** Calendar days (America/Lima) En destino before the customer message becomes due (same moment as the internal alert by default). */
  customerMessageDays: number
  /** Calendar days (America/Lima) En destino before the pickup condition becomes "En abandono". */
  abandonDays: number
  /** Automatic sends of the customer message per episode (a person can retry beyond it) and the backoff between FAILED attempts, in minutes (the last repeats). */
  messageMaxAttempts: number
  messageBackoffMinutes: number[]
  /** Technical poll log retention. */
  pollRetentionDays: number
  /** How long a global credentials failure pauses every query. */
  credentialsPauseMinutes: number
  /** Pause after a 429 without Retry-After, and the bounds applied to a Retry-After. */
  rateLimitPauseSeconds: { fallback: number; min: number; max: number }
}

export const SHALOM_DEFAULTS: ShalomConfig = {
  tickMinutes: 15,
  intervalMinutes: { at_origin: 180, in_transit: 180, at_destination: 720 },
  batchSize: 5,
  timeoutMs: 30_000,
  leaseSeconds: 600,
  backoffMinutes: [15, 30, 60, 120, 240, 360],
  attentionWindowHours: 24,
  refreshMinIntervalSeconds: 300,
  alertDays: 15,
  customerMessageDays: 15,
  abandonDays: 20,
  messageMaxAttempts: 3,
  messageBackoffMinutes: [5, 15, 60],
  pollRetentionDays: 30,
  credentialsPauseMinutes: 60,
  rateLimitPauseSeconds: { fallback: 60, min: 1, max: 900 },
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null)

/**
 * Defaults, optionally overridden by SHALOM_CONFIG_JSON (a partial JSON of the shape above) so QA can accelerate the clock without code changes. Anything
 * invalid is ignored (never throws, never loosens a safety bound to a non-positive number).
 */
export function readShalomConfig(env: Record<string, string | undefined> = process.env): ShalomConfig {
  const cfg: ShalomConfig = structuredClone(SHALOM_DEFAULTS)
  const raw = env.SHALOM_CONFIG_JSON
  if (!raw) return cfg
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return cfg
    o = parsed as Record<string, unknown>
  } catch {
    return cfg
  }
  for (const k of ['tickMinutes', 'batchSize', 'timeoutMs', 'leaseSeconds', 'attentionWindowHours', 'refreshMinIntervalSeconds', 'alertDays', 'customerMessageDays', 'abandonDays', 'messageMaxAttempts', 'pollRetentionDays', 'credentialsPauseMinutes'] as const) {
    const v = posInt(o[k])
    if (v !== null) cfg[k] = v
  }
  cfg.batchSize = Math.min(cfg.batchSize, 50)
  const iv = o.intervalMinutes
  if (typeof iv === 'object' && iv !== null) {
    for (const k of ['at_origin', 'in_transit', 'at_destination'] as const) {
      const v = posInt((iv as Record<string, unknown>)[k])
      if (v !== null) cfg.intervalMinutes[k] = v
    }
  }
  if (Array.isArray(o.backoffMinutes)) {
    const list = o.backoffMinutes.map(posInt)
    if (list.length > 0 && list.every((x): x is number => x !== null)) cfg.backoffMinutes = list
  }
  if (Array.isArray(o.messageBackoffMinutes)) {
    const list = o.messageBackoffMinutes.map(posInt)
    if (list.length > 0 && list.every((x): x is number => x !== null)) cfg.messageBackoffMinutes = list
  }
  const rl = o.rateLimitPauseSeconds
  if (typeof rl === 'object' && rl !== null) {
    for (const k of ['fallback', 'min', 'max'] as const) {
      const v = posInt((rl as Record<string, unknown>)[k])
      if (v !== null) cfg.rateLimitPauseSeconds[k] = v
    }
  }
  return cfg
}

/** The GLOBAL server-side kill switch: unless SHALOM_TRACKING_ENABLED is exactly "true" the cron does nothing at all (no claim, no query). */
export function isShalomGloballyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHALOM_TRACKING_ENABLED === 'true'
}

const addMinutes = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000)

/** When to ask again after a GOOD answer. A delivered shipment is never asked again (null). */
export function nextPollAfterSuccess(status: ShipmentStatus | null, now: Date, cfg: ShalomConfig): Date | null {
  if (status === 'delivered') return null
  const minutes = status === 'at_destination' ? cfg.intervalMinutes.at_destination : status === 'in_transit' ? cfg.intervalMinutes.in_transit : cfg.intervalMinutes.at_origin
  return addMinutes(now, minutes)
}

/** Bounded per-order backoff after a technical failure; `failures` counts this one (>= 1). */
export function nextPollAfterFailure(failures: number, now: Date, cfg: ShalomConfig): Date {
  const i = Math.min(Math.max(failures, 1), cfg.backoffMinutes.length) - 1
  return addMinutes(now, cfg.backoffMinutes[i])
}

/** When the next AUTOMATIC attempt of a FAILED customer message is due; null once the automatic attempts are used up (a person can still retry). */
export function nextMessageAttempt(attempt: number, now: Date, cfg: ShalomConfig): Date | null {
  if (attempt >= cfg.messageMaxAttempts) return null
  const i = Math.min(Math.max(attempt, 1), cfg.messageBackoffMinutes.length) - 1
  return addMinutes(now, cfg.messageBackoffMinutes[i])
}

/** Pause after a 429: Retry-After (seconds) when present, otherwise the fallback; always within [min, max]. */
export function rateLimitPauseSeconds(retryAfterSeconds: number | null | undefined, cfg: ShalomConfig): number {
  const { fallback, min, max } = cfg.rateLimitPauseSeconds
  const v = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds : fallback
  return Math.min(Math.max(Math.ceil(v), min), max)
}

/**
 * Has an ORDER-level error lasted long enough to need a person? True only when a first failure is already on record, older than the configured window.
 * One single 404 can never do it: the first failure starts the window.
 */
export function attentionWindowElapsed(firstFailureAt: Date | null, now: Date, cfg: ShalomConfig): boolean {
  if (!firstFailureAt) return false
  return now.getTime() - firstFailureAt.getTime() >= cfg.attentionWindowHours * 3_600_000
}

/**
 * Consistency warnings for a configuration (never throws, changes nothing). The one that matters for the REAL provider: a claim that is not finished
 * within `leaseSeconds` can be retaken by another worker, so the lease must cover the worst case of one tick (`batchSize` sequential queries that each
 * take their whole `timeoutMs`) plus a margin. The numbers stay provisional until Shalom's real limits are known.
 */
export function shalomConfigWarnings(cfg: ShalomConfig): string[] {
  const warnings: string[] = []
  const worstCaseSeconds = (cfg.batchSize * cfg.timeoutMs) / 1000
  if (cfg.leaseSeconds <= worstCaseSeconds) warnings.push(`leaseSeconds (${cfg.leaseSeconds}) must be greater than batchSize x timeoutMs (${worstCaseSeconds}s) plus a margin`)
  if (worstCaseSeconds > cfg.tickMinutes * 60) warnings.push(`a worst-case tick (${worstCaseSeconds}s) is longer than tickMinutes (${cfg.tickMinutes} min): ticks would overlap`)
  return warnings
}
