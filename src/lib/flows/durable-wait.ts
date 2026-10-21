/**
 * Pure helpers for durable waits: a `delay` node whose config carries { amount, unit }.
 *
 * A legacy delay ({ seconds }, 1-30 s) is an in-process sleep. A durable wait is persisted on the run (flow_runs.wait_*,
 * migration 069) and resumed later by the scheduler, so it can last up to 30 days and survives restarts.
 * The same limits are enforced in SQL by guard_durable_wait_node: keep them in sync.
 */
export const WAIT_UNITS = ["seconds", "minutes", "hours", "days"] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];

export const MAX_WAIT_SECONDS = 30 * 86_400;
const UNIT_SECONDS: Record<WaitUnit, number> = { seconds: 1, minutes: 60, hours: 3_600, days: 86_400 };

export interface DurableWaitConfig {
  amount: number;
  unit: WaitUnit;
  next_node_key: string;
}

/** A delay config is durable when it names a unit (legacy delays only have `seconds`). */
export function isDurableWaitConfig(config: unknown): boolean {
  return typeof config === "object" && config !== null && typeof (config as { unit?: unknown }).unit === "string";
}

export type WaitSeconds = { ok: true; seconds: number } | { ok: false; reason: "invalid_unit" | "invalid_amount" | "too_long" };

/** Total seconds of a durable wait, or why it is invalid (whole amount >= 1, known unit, at most 30 days). */
export function durableWaitSeconds(config: { amount?: unknown; unit?: unknown }): WaitSeconds {
  const unit = config.unit;
  if (typeof unit !== "string" || !(WAIT_UNITS as readonly string[]).includes(unit)) return { ok: false, reason: "invalid_unit" };
  const amount = config.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) return { ok: false, reason: "invalid_amount" };
  const seconds = amount * UNIT_SECONDS[unit as WaitUnit];
  return seconds > MAX_WAIT_SECONDS ? { ok: false, reason: "too_long" } : { ok: true, seconds };
}

/** The moment a wait started at `now` ends. */
export function computeResumeAt(seconds: number, now: Date): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/** Largest whole amount a unit can hold (30 days): used by the editor to bound its input. */
export function maxAmountFor(unit: WaitUnit): number {
  return Math.floor(MAX_WAIT_SECONDS / UNIT_SECONDS[unit]);
}
