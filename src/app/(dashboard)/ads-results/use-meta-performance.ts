'use client'

import { useEffect, useState } from 'react'
import type { MetaPerformance, MetaPerformanceAvailable } from '@/lib/meta-ads/performance'

/**
 * Meta's own numbers for the period (/api/ads/meta-performance, the SAME existing endpoint and request as before, now fetched once by the page and shared by
 * the per-ad detail and the global "Rendimiento Meta Ads" card). The response is stored together with the period it answers, so a stale period is never
 * rendered while the next one loads. Not configured / not synced / failed => null: Meta blocks are simply not offered and the rest of the page is unaffected.
 */
export function useMetaPerformance(days: number, enabled: boolean): MetaPerformanceAvailable | null {
  const [loaded, setLoaded] = useState<{ days: number; body: MetaPerformance | null } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ads/meta-performance?days=${days}`)
        const body = res.ok ? ((await res.json()) as MetaPerformance) : null
        if (!cancelled) setLoaded({ days, body })
      } catch {
        if (!cancelled) setLoaded({ days, body: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [days, enabled])

  const data = enabled && loaded && loaded.days === days ? loaded.body : null
  return data && data.available ? data : null
}
