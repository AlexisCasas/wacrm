import type { SupabaseClient } from '@supabase/supabase-js'
import type { InsightRow, MetaAd, MetaAdset, MetaCampaign, RangeLevel, RangeRow } from './client'
import type { Job, Reconciliation, SyncAccount, SyncStore } from './sync'

// Supabase (service_role) implementation of the sync store. Only error CODES are surfaced: no messages, rows or request details.
const fail = (what: string, error: { code?: string } | null) => new Error(`${what} failed: ${error?.code ?? 'error'}`)

export function createSupabaseSyncStore(admin: SupabaseClient): SyncStore {
  const upsert = async (table: string, rows: object[], onConflict: string) => {
    if (rows.length === 0) return
    const { error } = await admin.from(table).upsert(rows, { onConflict })
    if (error) throw fail(`${table} upsert`, error)
  }
  return {
    async listAccounts() {
      const { data, error } = await admin
        .from('meta_ads_settings')
        .select('account_id, ad_account_id, access_token_enc, api_version, currency, account_timezone, catalog_interval_minutes, insights_interval_minutes')
        .eq('enabled', true)
        .neq('token_status', 'invalid')
      if (error) throw fail('meta_ads_settings read', error)
      return ((data ?? []) as SyncAccount[]).filter((r) => r.ad_account_id && r.access_token_enc)
    },
    async ensureState(accountId, job) {
      const { error } = await admin.from('meta_ads_sync_state').upsert({ account_id: accountId, job }, { onConflict: 'account_id,job', ignoreDuplicates: true })
      if (error) throw fail('meta_ads_sync_state upsert', error)
    },
    async claim(accountId, job, nowIso, leaseUntilIso) {
      const { data, error } = await admin
        .from('meta_ads_sync_state')
        .update({ status: 'running', lease_until: leaseUntilIso, last_attempt_at: nowIso, updated_at: nowIso })
        .eq('account_id', accountId)
        .eq('job', job)
        .lte('next_run_at', nowIso)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .neq('status', 'paused')
        .select('consecutive_failures, covered_from, covered_to')
      if (error) throw fail('meta_ads_sync_state claim', error)
      const row = (data ?? [])[0] as { consecutive_failures?: number; covered_from?: string | null; covered_to?: string | null } | undefined
      return { claimed: !!row, failures: row?.consecutive_failures ?? 0, coveredFrom: row?.covered_from ?? null, coveredTo: row?.covered_to ?? null }
    },
    upsertAds: (accountId: string, ads: MetaAd[], nowIso: string) => upsert('meta_ads_ads', ads.map((a) => ({ account_id: accountId, ...a, last_synced_at: nowIso })), 'account_id,ad_id'),
    upsertAdsets: (accountId: string, rows: MetaAdset[], nowIso: string) => upsert('meta_ads_adsets', rows.map((r) => ({ account_id: accountId, ...r, last_synced_at: nowIso })), 'account_id,adset_id'),
    upsertCampaigns: (accountId: string, rows: MetaCampaign[], nowIso: string) => upsert('meta_ads_campaigns', rows.map((r) => ({ account_id: accountId, ...r, last_synced_at: nowIso })), 'account_id,campaign_id'),
    upsertInsights: (accountId: string, rows: InsightRow[], currency: string, nowIso: string) =>
      upsert('meta_ads_insights_daily', rows.map((r) => ({ account_id: accountId, ...r, currency, synced_at: nowIso })), 'account_id,ad_id,date'),
    async upsertRange(accountId: string, level: RangeLevel, days: number, since: string, until: string, rows: RangeRow[], currency: string, nowIso: string) {
      if (rows.length === 0) return
      // The range row first (actions reference it), then the actions. Every optional column is written explicitly (NULL when absent) so a new window never inherits the previous window's value.
      await upsert('meta_ads_insights_range', rows.map((r) => ({
        account_id: accountId, level, entity_id: r.entity_id, days, since, until, spend: r.spend, impressions: r.impressions, clicks: r.clicks, reach: r.reach, frequency: r.frequency,
        ctr: r.ctr, cpc: r.cpc, cpm: r.cpm, inline_link_clicks: r.inline_link_clicks, outbound_clicks: r.outbound_clicks, currency, synced_at: nowIso,
      })), 'account_id,level,entity_id,days')
      await upsert('meta_ads_actions_range', rows.flatMap((r) => r.actions.map((a) => ({
        account_id: accountId, level, entity_id: r.entity_id, days, action_type: a.action_type, since, until, value: a.value, synced_at: nowIso,
      }))), 'account_id,level,entity_id,days,action_type')
    },
    async pruneRange(accountId: string, level: RangeLevel, days: number, beforeIso: string, includeActions: boolean) {
      if (includeActions) {
        const a = await admin.from('meta_ads_actions_range').delete().eq('account_id', accountId).eq('level', level).eq('days', days).lt('synced_at', beforeIso)
        if (a.error) throw fail('meta_ads_actions_range prune', a.error)
      }
      const r = await admin.from('meta_ads_insights_range').delete().eq('account_id', accountId).eq('level', level).eq('days', days).lt('synced_at', beforeIso)
      if (r.error) throw fail('meta_ads_insights_range prune', r.error)
    },
    async finishOk(accountId, job: Job, v) {
      const { error } = await admin
        .from('meta_ads_sync_state')
        .update({
          status: 'ok', lease_until: null, next_run_at: v.nextRunAtIso, last_success_at: v.nowIso, last_rows: v.rows, last_pages: v.pages,
          consecutive_failures: 0, last_error_code: null, last_error_summary: null, updated_at: v.nowIso,
          ...(v.coveredFrom !== undefined ? { covered_from: v.coveredFrom } : {}), ...(v.coveredTo !== undefined ? { covered_to: v.coveredTo } : {}),
        })
        .eq('account_id', accountId)
        .eq('job', job)
      if (error) throw fail('meta_ads_sync_state finish', error)
    },
    async finishError(accountId, job: Job, v) {
      const { error } = await admin
        .from('meta_ads_sync_state')
        .update({
          status: v.paused ? 'paused' : 'error', lease_until: null, next_run_at: v.nextRunAtIso, consecutive_failures: v.failures,
          last_error_code: v.code, last_error_summary: v.code, updated_at: v.nowIso,
          // progress made before the failure is kept (the data was already stored); coverage never moves backwards
          ...(v.coveredFrom ? { covered_from: v.coveredFrom } : {}), ...(v.coveredTo ? { covered_to: v.coveredTo } : {}),
        })
        .eq('account_id', accountId)
        .eq('job', job)
      if (error) throw fail('meta_ads_sync_state finish', error)
    },
    async setTokenStatus(accountId, status, nowIso) {
      const patch =
        status === 'invalid'
          ? { token_status: status, disabled_reason: 'token_rejected_by_meta', disabled_at: nowIso, updated_at: nowIso }
          : { token_status: status, updated_at: nowIso }
      const { error } = await admin.from('meta_ads_settings').update(patch).eq('account_id', accountId)
      if (error) throw fail('meta_ads_settings update', error)
    },
    async localTotals(accountId, since, until) {
      const { data, error } = await admin.rpc('meta_ads_insights_totals', { p_account: accountId, p_from: since, p_to: until })
      if (error) throw fail('meta_ads_insights_totals', error)
      const r = ((data ?? [])[0] ?? {}) as { spend?: number | string; impressions?: number | string; clicks?: number | string }
      return { spend: String(r.spend ?? 0), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0) }
    },
    async reconciledAt(accountId) {
      const { data, error } = await admin.from('meta_ads_reconciliation').select('window_days, checked_at').eq('account_id', accountId)
      if (error) throw fail('meta_ads_reconciliation read', error)
      const out: Partial<Record<number, string>> = {}
      for (const r of (data ?? []) as { window_days: number; checked_at: string }[]) out[r.window_days] = r.checked_at
      return out
    },
    async saveReconciliation(accountId, rec: Reconciliation, nowIso) {
      await upsert('meta_ads_reconciliation', [{
        account_id: accountId, window_days: rec.windowDays, date_from: rec.dateFrom, date_to: rec.dateTo,
        local_spend: rec.local.spend, meta_spend: rec.meta.spend, local_impressions: rec.local.impressions, meta_impressions: rec.meta.impressions,
        local_clicks: rec.local.clicks, meta_clicks: rec.meta.clicks, ok: rec.ok, checked_at: nowIso,
      }], 'account_id,window_days')
    },
  }
}
