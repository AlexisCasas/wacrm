import type { AdsReport, MetaAdInfo } from '@/lib/meta-capi/report'

// Optional, read-only enrichment of the ads report with the SYNCED Meta ad catalog. It never changes a number and never removes the source_id:
// it only adds `meta` to rows that already exist. Names come exclusively from the catalog, never from the headline.

export interface CatalogRow {
  ad_id: string
  name: string | null
  adset_name: string | null
  campaign_name: string | null
  status: string | null
  effective_status: string | null
  last_synced_at: string | null
}

const REAL_AD_ID = /^[0-9]{6,25}$/

/** Real Meta ad ids shown in the report (excludes the unattributed bucket and the '(sin id de anuncio)' placeholder). */
export function reportAdIds(report: AdsReport): string[] {
  const ids = new Set<string>()
  for (const a of report.ads) if (a.source_id && REAL_AD_ID.test(a.source_id)) ids.add(a.source_id)
  for (const p of report.product_sales ?? []) for (const a of p.ads ?? []) if (a.source_id && REAL_AD_ID.test(a.source_id)) ids.add(a.source_id)
  return [...ids]
}

const info = (r: CatalogRow): MetaAdInfo => ({
  name: r.name,
  campaign_name: r.campaign_name,
  adset_name: r.adset_name,
  status: r.status,
  effective_status: r.effective_status,
})

/**
 * @param catalog rows found for the ids shown; null/undefined = the lookup failed or is not available => the report is left untouched.
 * @param syncedAt last completed full catalog pass for the account; null = never synced => the report is left untouched.
 */
export function attachMetaCatalog(report: AdsReport, catalog: CatalogRow[] | null | undefined, syncedAt: string | null | undefined): AdsReport {
  if (!catalog || !syncedAt) return report
  const byId = new Map(catalog.map((r) => [r.ad_id, r]))
  const lookup = (id: string | null): MetaAdInfo | null | undefined => {
    if (!id || !REAL_AD_ID.test(id)) return undefined // unattributed / placeholder rows are not ads
    const r = byId.get(id)
    return r ? info(r) : null // null = "Anuncio no sincronizado"
  }
  for (const a of report.ads) a.meta = lookup(a.source_id)
  for (const p of report.product_sales ?? []) for (const a of p.ads ?? []) a.meta = lookup(a.source_id)
  report.meta_catalog = { available: true, synced_at: syncedAt }
  return report
}
