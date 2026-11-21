/**
 * Call duration for the Inbox history.
 *
 * Meta's terminate duration is authoritative when present. Only when it is
 * absent may the API derive whole seconds from terminate.start_time and
 * terminate.end_time, which are the only timestamps persisted as call timing.
 * ACCEPTED is a state/audit event, not the exact media start. Rejected,
 * failed, unanswered and active calls never receive a displayed duration.
 */
type CallTiming = {
  state?: string | null
  duration_seconds?: number | null
  started_at?: string | null
  ended_at?: string | null
}

const MAX_DURATION_SECONDS = 2_147_483_647

export function effectiveCallDuration(call: CallTiming): number | null {
  if (call.state !== 'terminated') return null

  const reported = call.duration_seconds
  if (Number.isSafeInteger(reported) && reported !== null
    && reported >= 0 && reported <= MAX_DURATION_SECONDS) {
    return reported
  }

  if (!call.started_at || !call.ended_at) return null
  const started = Date.parse(call.started_at)
  const ended = Date.parse(call.ended_at)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null

  const derived = Math.floor((ended - started) / 1000)
  return Number.isSafeInteger(derived) && derived >= 0 && derived <= MAX_DURATION_SECONDS
    ? derived
    : null
}
