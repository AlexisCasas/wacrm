import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { GoogleSheetsClient, readGoogleCredentials } from '@/lib/orders/sheets/google-client'
import { runSheetsExport } from '@/lib/orders/sheets/exporter'
import { reconcileAccount } from '@/lib/orders/sheets/reconcile'

// Google Sheets export tick. Independent of the InkaClick outbox (/api/orders/cron): a failure here never touches an order or its delivery.
// Global switch: without ORDERS_SHEETS_EXPORT_ENABLED=true plus the service-account env vars it does nothing. Per account: order_sheet_destinations.enabled.
//   GET ?mode=sync (default)  export due orders        GET ?mode=reconcile  read-only DB<->sheet comparison (aggregates and order ids only)
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
    for (const { account_id } of (data ?? []) as { account_id: string }[]) {
      // One account failing must not stop the others.
      try {
        if (mode === 'sync') accounts[account_id] = await runSheetsExport(admin, api, account_id)
        else {
          const r = await reconcileAccount(admin, api, account_id)
          accounts[account_id] = { ...r, missingKeys: r.missingKeys.slice(0, 20), extraKeys: r.extraKeys.slice(0, 20), duplicateKeys: r.duplicateKeys.slice(0, 20), lineMismatches: r.lineMismatches.slice(0, 20) }
        }
      } catch (e) {
        console.error('[orders-sheets] account failed:', account_id, e instanceof Error ? e.message : 'unknown')
        accounts[account_id] = { error: 'account_failed' }
      }
    }
    return NextResponse.json({ enabled: true, mode, accounts })
  } catch (error) {
    console.error('[orders-sheets] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'sheets export failed' }, { status: 500 })
  }
}
