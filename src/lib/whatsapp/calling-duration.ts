/**
 * Call duration for the Inbox history.
 *
 * The webhook processor persists Meta's explicit duration, or derives it
 * from the start_time/end_time pair in the same terminate event. The API must
 * not derive from stored timestamps: older application versions could have
 * written a provisional ACCEPTED timestamp into started_at.
 */
type CallTiming = {
  state?: string | null
  duration_seconds?: number | null
}

const MAX_DURATION_SECONDS = 2_147_483_647

export function effectiveCallDuration(call: CallTiming): number | null {
  if (call.state !== 'terminated') return null
  const duration = call.duration_seconds
  return Number.isSafeInteger(duration)
    && duration !== null
    && duration >= 0
    && duration <= MAX_DURATION_SECONDS
    ? duration
    : null
}
