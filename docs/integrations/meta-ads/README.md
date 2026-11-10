# Meta Ads — foundation, catalog, ad sets/campaigns and daily insights (phases 1–4)

Read-only enrichment of `/ads-results` with the REAL ad name, campaign, ad set and status from Meta, plus a separate section **Rendimiento Meta Ads**
(spend, impressions, clicks, CTR, CPC, CPM by campaign / ad set / ad over 7, 30 and 90 complete Meta days). The Meta Ad ID is `contact_ad_attributions.source_id`
and is always kept. **Not implemented on purpose:** CPA, ROAS, cost per contact, spend per sold product, Consultaron, per-product conversion, and any reach for
7/30/90 days (daily reach is stored for information only; it is not additive and is never summed or shown).

## Pieces
| Piece | Where |
|---|---|
| Phase 3-4 schema: `meta_ads_campaigns`, `meta_ads_adsets`, `meta_ads_insights_daily` (PK account_id, ad_id, date; NUMERIC spend), `meta_ads_reconciliation`, functions `meta_ads_performance` (read) and `meta_ads_insights_totals` (service_role) | `supabase/migrations/20261117000000_meta_ads_insights.sql` (after 20261116; rollback: `ROLLBACK-insights.sql` first, then `ROLLBACK-catalog.sql`) |
| Tables `meta_ads_settings` (token, service_role only), `meta_ads_ads` (catalog), `meta_ads_sync_state` + function `ads_results_meta_catalog` | `supabase/migrations/20261116000000_meta_ads_catalog.sql` (rollback: `ROLLBACK-catalog.sql`) |
| Sync engine: jobs `campaigns`, `adsets`, `catalog`, `insights` (paginated, idempotent upsert, backoff, lease, 90-day backfill, 3-day refresh, reconciliation) | `src/lib/meta-ads/{client,sync,sync-store}.ts`, `src/app/api/meta-ads/cron/route.ts` |
| Read layer + section | `src/lib/meta-ads/performance.ts`, `src/app/api/ads/meta-performance/route.ts`, `ads-results/meta-ads-performance.tsx` |
| Enrichment of the report (optional, never blocks it) | `src/lib/meta-ads/enrich.ts`, `src/app/api/ads/results/route.ts`, `ads-results/page.tsx` |
| Token enrol / rotate / revoke | `scripts/ops/meta-ads/set-token.sh`, `clear-token.sql` |

## Switches (both OFF by default)
1. Process env `META_ADS_ENABLED=true` (otherwise the cron route does nothing and never calls Meta).
2. `meta_ads_settings.enabled = TRUE` for the account (set by `set-token.sh --enable`).

## Operator runbook (after deploy; nothing here has been run)
```bash
# 1. enrol the token without displaying it (prompt has echo off); validates ad account currency/timezone + one catalog row first
scripts/ops/meta-ads/set-token.sh --account-id <WACRM account uuid> --ad-account-id <numeric Meta Ad Account id> --dry-run
scripts/ops/meta-ads/set-token.sh --account-id <WACRM account uuid> --ad-account-id <numeric Meta Ad Account id> --enable
# 2. add META_ADS_ENABLED=true to the app env, recreate only `app`, and add a cron entry calling GET /api/meta-ads/cron with header x-cron-secret
#    (same convention as /api/meta-capi/cron), every 15 minutes: the account itself only syncs when `next_run_at` is due (default every 60 min).
```
Rotation: run `set-token.sh` again with the new token, then revoke the old one in Meta Business Settings.
Revocation: revoke in Meta, then `clear-token.sql` (wipes the ciphertext, disables, pauses the sync).

## Behaviour
* A full paginated pass is the only thing that marks the catalog "synced" (`last_success_at`); ads are upserted per page and never deleted.
* A `source_id` not yet in the catalog shows **Anuncio no sincronizado** (+ its id) until the next full pass. Names are never inferred from the headline.
* No Meta, token error (Meta code 190 → token marked invalid, sync paused), rate limit or outage: `/ads-results` is exactly as before.
* `GET /{ad_id}` and `?ids=` are deliberately NOT used (they returned HTTP 400 with this token); only the ad-account catalog edge is.

## Insights behaviour
* Source: `GET act_<id>/insights?level=ad&time_increment=1&time_range={since,until}` (full pagination). `date` = Meta `date_start` (calendar day of the ad account, America/Bogota). `captured_at` of WACRM is never used for Meta metrics.
* First run: newest 7 days, then backfill downwards in 7-day blocks to 90 days (up to 6 blocks per run, coverage saved after each block, resumable). Maintenance: every run re-fetches the last 3 days + today and fills any gap since the last run. Nothing valid is ever deleted.
* UI periods 7/30/90 = the N complete Meta days before today (today excluded, like Meta's `last_Nd`). Ratios come from the totals of each row (CTR = clicks/impressions*100, CPC = spend/clicks, CPM = spend/impressions*1000; zero denominators show "—").
* Reconciliation: each window (7/30/90) is compared with Meta's `level=account` totals as soon as it is fully stored and then about once a day; spend to the cent, impressions and clicks exactly. A difference is stored with `ok=false` and shown; it is never hidden or tolerated silently. **Do not deploy if a reconciliation shows unexplained differences.**
* The section only appears if the insights sync exists for the account; if Meta or the new tables fail, only the section is omitted.
* Live validation (manual, PowerShell, real token): `campaigns`, `adsets`, `ads` (catalog) and `insights level=ad` endpoints answered correctly. `GET /{ad_id}` and `?ids=` are not used.

## SQL QA (disposable database)
`qa/meta-ads/run-sql-qa.sh` applies 20261116 -> 20261117 on an empty, network-less, tmpfs PostgreSQL container with synthetic data (273 checks: types, PK/FK/CHECK, RLS, grants, token isolation, functions, 7/30/90 windows, zero division, reach not summed, id-keyed grouping, rollback drill), destroys it and replays everything on a second empty database. `META_ADS_QA_JSON=<outdir>/round1.json vitest run src/lib/meta-ads/qa-db.test.ts` cross-checks the app read model against the real SQL output.
