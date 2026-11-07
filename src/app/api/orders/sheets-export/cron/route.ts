import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { GoogleSheetsClient, readGoogleCredentials } from '@/lib/orders/sheets/google-client'
import { runSheetsExport } from '@/lib/orders/sheets/exporter'
import { reconcileAccount } from '@/lib/orders/sheets/reconcile'
import { DEFAULT_RETRY, reconcileWithRetry } from '@/lib/orders/sheets/reconcile-run'
import { publishControl } from '@/lib/orders/sheets/control'
import { loadDestination } from '@/lib/orders/sheets/exporter'
import { classifyExport, classifyReconcileRun, overall, type AccountOutcome } from '@/lib/orders/sheets/status'

// Google Sheets export tick. Independent of the InkaClick outbox (/api/orders/cron): a failure here never touches an order or its delivery.
// Global switch: without ORDERS_SHEETS_EXPORT_ENABLED=true plus the service-account env vars it does nothing. Per account: order_sheet_destinations.enabled.
//   GET ?mode=sync (default)  export due orders        GET ?mode=reconcile  export first, then DB<->sheet comparison (aggregates and order ids only), with a bounded retry
//   for lag only (reconcile-run.ts); it also writes the figures of the final pass to the sheet's control tab (never anywhere else).
//   ?publish=0 keeps the comparison from writing the control tab; ?presync=0 compares without exporting first and without retries (diagnostic, strictly read-only with publish=0).
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode = new URL(request.url).searchParams.get('mode') ?? 'sync'
  if (mode !== 'sync' && mode !== 'reconcile') return NextResponse.json({ error: 'bad mode' }, { status: 400 })
  try {
    const creds = readGoogleCredentials()
    if (!creds) return NextResponse.json({ enabled: false })
    const admin = supabaseAdmin()
    const { data, error } = await admin.from('order_sheet_destinations').select('account_id').eq('enabled', true)
    if (error) throw new Error(error.message)
    const api = new GoogleSheetsClient(creds)
    const accounts: Record<string, unknown> = {}
    const outcomes: AccountOutcome[] = []
    let attempts = 1
    for (const { account_id } of (data ?? []) as { account_id: string }[]) {
      // One account failing must not stop the others.
      try {
        if (mode === 'sync') {
          const r = await runSheetsExport(admin, api, account_id)
          accounts[account_id] = r
          outcomes.push({ account: account_id, ...classifyExport(r) })
        }
        else {
          const sp = new URL(request.url).searchParams
          const run = await reconcileWithRetry({
            sync: sp.get('presync') === '0' ? null : () => runSheetsExport(admin, api, account_id),
            reconcile: () => reconcileAccount(admin, api, account_id),
          }, DEFAULT_RETRY)
          const r = run.report
          // Publish the figures of the FINAL comparison to the control tab (default). The sheet's status turns SIN CONCILIAR / VENCIDA if this stops happening.
          if (sp.get('publish') !== '0') {
            const dest = await loadDestination(admin, account_id)
            if (dest) await publishControl(api, dest.spreadsheet_id, r, Date.now())
          }
          outcomes.push({ account: account_id, ...classifyReconcileRun(run) })
          attempts = Math.max(attempts, run.attempts)
          accounts[account_id] = {
            attempts: run.attempts, recoveredAfterRetry: run.recoveredAfterRetry, history: run.history,
            sync: run.sync && { exported: run.sync.exported, appendedLines: run.sync.appendedLines, retried: run.sync.retried, mismatched: run.sync.mismatched, deadOutstanding: run.sync.deadOutstanding, skipped: run.sync.skipped, error: run.sync.error },
            ...r, missingKeys: r.missingKeys.slice(0, 20), extraKeys: r.extraKeys.slice(0, 20), duplicateKeys: r.duplicateKeys.slice(0, 20), lineMismatches: r.lineMismatches.slice(0, 20), contentMismatches: r.contentMismatches.slice(0, 20),
          }
        }
      } catch (e) {
        console.error('[orders-sheets] account failed:', account_id, e instanceof Error ? e.message : 'unknown')
        accounts[account_id] = { error: 'account_failed' }
        outcomes.push({ account: account_id, status: 'attention', reasons: ['account_failed'] })
      }
    }
    // HTTP 200 only when nothing needs a person: the host cron script logs and alerts on any other status.
    const o = overall(outcomes)
    return NextResponse.json({ enabled: true, mode, status: o.status, ...(mode === 'reconcile' ? { attempts } : {}), attention: outcomes.filter((x) => x.status === 'attention').map((x) => ({ account: x.account, reasons: x.reasons })), accounts }, { status: o.http })
  } catch (error) {
    console.error('[orders-sheets] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'sheets export failed' }, { status: 500 })
  }
}
