import type { SupabaseClient } from '@supabase/supabase-js'
import { nextAttemptDelayMs, MAX_ATTEMPTS } from '../backoff'
import { SheetsError, type SheetsApi } from './google-client'
import { indexRows } from './plan'
import { HEADERS, ProjectionError, compareRow, projectOrder, type ItemInput, type OrderInput, type ProjectedOrder } from './layout'

// Sheets export worker. Order of operations is what makes it safe:
//   discover (pull) -> take the destination lease -> claim jobs -> RE-READ the sheet -> append only the lines that are missing -> RE-READ and verify -> mark done.
// A crash or an ambiguous append (timeout after Google applied it) is therefore harmless: the next run sees the keys already in the sheet and does not write them again.
// Nothing in here is called from the order-confirmation or InkaClick paths; a failure here can never block or re-send a commercial order.

export interface ExportResult {
  enabled: boolean
  skipped?: 'lease_held' | 'destination_off'
  discovered: number
  claimed: number
  exported: number
  alreadyPresent: number
  appendedLines: number
  retried: number
  dead: number
  mismatched: number          // jobs quarantined because an existing row differs from its projection
  deadOutstanding: number     // jobs currently dead for this account (needs a person), not just this run
  error?: string
}
export const emptyResult = (enabled: boolean): ExportResult => ({ enabled, discovered: 0, claimed: 0, exported: 0, alreadyPresent: 0, appendedLines: 0, retried: 0, dead: 0, mismatched: 0, deadOutstanding: 0 })

interface Destination { account_id: string; spreadsheet_id: string; registry_tab: string; enabled: boolean }
interface Job { order_id: string; attempts: number }

async function logEvent(admin: SupabaseClient, account: string, event: string, code?: string, detail: Record<string, unknown> = {}, order?: string): Promise<void> {
  await admin.from('order_sheet_events').insert({ account_id: account, order_id: order ?? null, event, code: code ?? null, detail })
}

export async function loadDestination(admin: SupabaseClient, accountId: string): Promise<Destination | null> {
  const { data, error } = await admin.from('order_sheet_destinations').select('account_id, spreadsheet_id, registry_tab, enabled').eq('account_id', accountId).maybeSingle()
  if (error) throw new Error(`destination lookup failed: ${error.message}`)
  return (data as Destination | null) ?? null
}

export async function checkLayout(api: SheetsApi, d: Destination): Promise<void> {
  const header = await api.headerRow(d.spreadsheet_id, d.registry_tab)
  for (let i = 0; i < HEADERS.length; i++) if ((header[i] ?? '') !== HEADERS[i]) throw new SheetsError('layout_mismatch', true)
}

async function loadOrders(admin: SupabaseClient, ids: string[]): Promise<{ orders: Map<string, OrderInput>; items: Map<string, ItemInput[]> }> {
  const cols = 'id, account_id, confirmed_at, customer_name, dni, phone, product, quantity, price, order_description, agency, destination, seller_name, order_status, department'
  const o = await admin.from('order_confirmations').select(cols).in('id', ids)
  if (o.error) throw new Error(`orders read failed: ${o.error.message}`)
  const it = await admin.from('order_confirmation_items').select('order_id, line_number, catalog_product_id, product_name, quantity, unit_price, subtotal').in('order_id', ids)
  if (it.error) throw new Error(`items read failed: ${it.error.message}`)
  const items = new Map<string, ItemInput[]>()
  for (const r of (it.data ?? []) as (ItemInput & { order_id: string })[]) { const a = items.get(r.order_id) ?? []; a.push(r); items.set(r.order_id, a) }
  return { orders: new Map(((o.data ?? []) as OrderInput[]).map((r) => [r.id, r])), items }
}

export async function runSheetsExport(
  admin: SupabaseClient,
  api: SheetsApi,
  accountId: string,
  opts: { batch?: number; maxBatches?: number; now?: () => Date; random?: () => number } = {},
): Promise<ExportResult> {
  const result = emptyResult(true)
  const dest = await loadDestination(admin, accountId)
  if (!dest || !dest.enabled) return { ...result, skipped: 'destination_off' }
  const now = opts.now ?? (() => new Date())

  const enq = await admin.rpc('order_sheet_enqueue', { p_account: accountId })
  if (enq.error) throw new Error(`order_sheet_enqueue failed: ${enq.error.message}`)
  result.discovered = Number(enq.data ?? 0)

  const acq = await admin.rpc('order_sheet_acquire', { p_account: accountId, p_lease_seconds: 240 })
  if (acq.error) throw new Error(`order_sheet_acquire failed: ${acq.error.message}`)
  const token = acq.data as string | null
  if (!token) return { ...result, skipped: 'lease_held' }

  try {
    await checkLayout(api, dest)
    for (let b = 0; b < (opts.maxBatches ?? 10); b++) {
      const claim = await admin.rpc('order_sheet_claim', { p_account: accountId, p_token: token, p_limit: opts.batch ?? 50, p_lock_seconds: 240, p_max_attempts: MAX_ATTEMPTS })
      if (claim.error) throw new Error(`order_sheet_claim failed: ${claim.error.message}`)
      const jobs = (claim.data ?? []) as Job[]
      if (jobs.length === 0) break
      result.claimed += jobs.length

      const fail = async (job: Job, code: string, permanent: boolean, retryAfterMs?: number) => {
        const delay = Math.ceil(nextAttemptDelayMs(job.attempts, retryAfterMs, opts.random) / 1000)
        const r = await admin.rpc('order_sheet_fail', { p_order: job.order_id, p_token: token, p_code: code, p_retry_in_seconds: delay, p_permanent: permanent, p_max_attempts: MAX_ATTEMPTS })
        if (r.data === 'dead') result.dead++; else if (r.data === 'pending') result.retried++
        await logEvent(admin, accountId, r.data === 'dead' ? 'job_dead' : 'job_retry', code, { attempts: job.attempts }, job.order_id)
      }

      const { orders, items } = await loadOrders(admin, jobs.map((j) => j.order_id))
      const projected = new Map<string, ProjectedOrder>()
      for (const job of jobs) {
        const o = orders.get(job.order_id)
        if (!o) { await fail(job, 'order_missing', true); continue }
        try { projected.set(job.order_id, projectOrder(o, items.get(job.order_id) ?? [], now().toISOString())) }
        catch (e) { await fail(job, e instanceof ProjectionError ? e.code : 'projection_error', true) }
      }
      const live = jobs.filter((j) => projected.has(j.order_id))
      if (live.length === 0) continue

      try {
        const before = indexRows(await api.rows(dest.spreadsheet_id, dest.registry_tab))
        // An existing key must carry exactly the projected content. A divergent row is never overwritten and never counted as exported.
        const blocked = new Map<string, string[]>()
        for (const j of live) for (const l of projected.get(j.order_id)!.lines) {
          const row = before.first.get(l.key)
          if (!row) continue
          const diffs = compareRow(l.cells, row)
          if (diffs.length) blocked.set(j.order_id, [...(blocked.get(j.order_id) ?? []), ...diffs])
        }
        const writable = live.filter((j) => !blocked.has(j.order_id))
        for (const j of live) if (blocked.has(j.order_id)) {
          result.mismatched++
          await logEvent(admin, accountId, 'row_content_mismatch', 'row_content_mismatch', { columns: [...new Set(blocked.get(j.order_id))] }, j.order_id)
          await fail(j, 'row_content_mismatch', true)
        }
        const toWrite = writable.flatMap((j) => projected.get(j.order_id)!.lines.filter((l) => !before.first.has(l.key)))
        for (const j of writable) if (projected.get(j.order_id)!.lines.every((l) => before.first.has(l.key))) result.alreadyPresent++
        if (toWrite.length > 0) {
          const renewed = await admin.rpc('order_sheet_renew', { p_account: accountId, p_token: token, p_lease_seconds: 240 })
          if (renewed.error || renewed.data !== true) throw new SheetsError('lease_lost', true)
          await api.append(dest.spreadsheet_id, dest.registry_tab, toWrite.map((l) => l.cells))
          result.appendedLines += toWrite.length
        }
        const after = indexRows(await api.rows(dest.spreadsheet_id, dest.registry_tab))
        for (const job of writable) {
          const p = projected.get(job.order_id)!
          const present = p.lines.map((l) => after.count.get(l.key) ?? 0)
          if (present.some((c) => c > 1)) { await logEvent(admin, accountId, 'duplicate_detected', 'duplicate_key', {}, job.order_id); await fail(job, 'duplicate_key', true); continue }
          if (present.some((c) => c === 0)) { await fail(job, 'verify_missing', false); continue }
          const bad = p.lines.flatMap((l) => compareRow(l.cells, after.first.get(l.key)!))
          if (bad.length) { result.mismatched++; await logEvent(admin, accountId, 'row_content_mismatch', 'row_content_mismatch', { columns: [...new Set(bad)] }, job.order_id); await fail(job, 'row_content_mismatch', true); continue }
          const ok = await admin.rpc('order_sheet_complete', { p_order: job.order_id, p_token: token, p_lines: p.lines.length, p_units: p.units, p_total: p.totalCents / 100 })
          if (ok.error || ok.data !== true) throw new SheetsError('lease_lost', true)
          result.exported++
        }
      } catch (e) {
        const code = e instanceof SheetsError ? e.code : 'export_error'
        const retryAfter = e instanceof SheetsError ? e.retryAfterMs : undefined
        const permanent = e instanceof SheetsError && !e.retryable
        for (const job of live) await fail(job, code, permanent, retryAfter).catch(() => undefined)
        result.error = code
        break
      }
    }
  } catch (e) {
    result.error = e instanceof SheetsError ? e.code : 'export_error'
    await logEvent(admin, accountId, 'run_error', result.error).catch(() => undefined)
  } finally {
    await admin.rpc('order_sheet_release', { p_account: accountId, p_token: token })
  }
  const dead = await admin.from('order_sheet_exports').select('order_id', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'dead')
  result.deadOutstanding = dead.count ?? 0
  return result
}
