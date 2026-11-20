/**
 * Call duration for the Inbox history.
 *
 * Meta's terminate webhook is the authoritative source for `duration` and
 * `start_time`, but it only reports them for connected calls. When the stored
 * `duration_seconds` is missing (older rows, or a terminate that omitted it)
 * derive it from `started_at`/`ended_at`, which are persisted from the call
 * status events. Unanswered, rejected and failed calls have no start time and
 * therefore no duration: never invent one from `created_at`.
 */
type CallTiming = {
  state?: string | null
  duration_seconds?: number | null
  started_at?: string | null
  ended_at?: string | null
}

const TERMINAL_STATES = new Set(['terminated', 'failed', 'rejected'])

export function effectiveCallDuration(call: CallTiming): number | null {
  if (typeof call.duration_seconds === 'number' && Number.isFinite(call.duration_seconds) && call.duration_seconds >= 0) {
    return call.duration_seconds
  }
  if (!call.state || !TERMINAL_STATES.has(call.state)) return null
  if (call.state !== 'terminated' || !call.started_at || !call.ended_at) return null
  const started = Date.parse(call.started_at)
  const ended = Date.parse(call.ended_at)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null
  return Math.floor((ended - started) / 1000)
}
