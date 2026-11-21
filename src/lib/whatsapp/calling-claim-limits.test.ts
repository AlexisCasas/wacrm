import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CALLING_ACCEPT_LIMITS } from '@/components/inbox/calling-panel'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * CALL-03B2.4 — the client timing contract must stay tied to the real server
 * limits (lease, SDP validity, rate limit). If a server value changes, this
 * fails and the client constants have to be reviewed.
 */
const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('claim-before-microphone limits', () => {
  it('client constants match the agreed contract', () => {
    expect(CALLING_ACCEPT_LIMITS).toEqual({
      claimLeaseMs: 90_000,
      heartbeatMs: 30_000,
      micTimeoutMaxMs: 30_000,
      offerSafetyMarginMs: 15_000,
      minMicWindowMs: 5_000,
    })
  })

  it('the lease is 90 s in the claim and renew RPCs and in the route response', () => {
    const claim = read('supabase/migrations/20261130000003_whatsapp_calling_inbound_association_lifecycle.sql')
    expect(claim).toMatch(/claim_expires_at=now\(\)\+interval '90 seconds'/)
    const renew = read('supabase/migrations/20261130000000_whatsapp_calling_agent_attribution.sql')
    expect(renew).toMatch(/claim_expires_at=now\(\)\+interval '90 seconds'/)
    expect(read('src/app/api/whatsapp/calls/route.ts')).toMatch(/lease_seconds: action === 'claim' \|\| action === 'renew_claim' \? 90 : 0/)
  })

  it('the inbound offer SDP lives 60 s from the webhook', () => {
    expect(read('src/lib/whatsapp/calling-webhook-processor.ts')).toMatch(/direction === 'USER_INITIATED' \? 60_000/)
  })

  it('the heartbeat leaves room for missed beats inside one lease', () => {
    const { claimLeaseMs, heartbeatMs, micTimeoutMaxMs, offerSafetyMarginMs, minMicWindowMs } = CALLING_ACCEPT_LIMITS
    expect(heartbeatMs * 2).toBeLessThan(claimLeaseMs) // two missed beats still inside the lease
    expect(micTimeoutMaxMs).toBeLessThanOrEqual(heartbeatMs) // no heartbeat is needed during the dialog
    expect(offerSafetyMarginMs + minMicWindowMs).toBeLessThan(60_000)
  })

  it('claim, renew and release share the real 60/min per-agent budget', () => {
    expect(RATE_LIMITS.send).toEqual({ limit: 60, windowMs: 60_000 })
    const route = read('src/app/api/whatsapp/calls/route.ts')
    expect(route).toMatch(/checkRateLimit\(`calling:\$\{userId\}`, RATE_LIMITS\.send\)/)
    // Heartbeat (2/min) + a full accept (~7) is far below the budget.
    expect(2 + 7).toBeLessThan(RATE_LIMITS.send.limit)
  })
})
