import { NextResponse } from 'next/server'
import { guarded, json } from '@/lib/audio-guide/api'
import { CatalogLookupError, lookupProductAudios } from '@/lib/audio-guide/lookup'

/**
 * GET /api/audio-guide/lookup?value=<Producto text> — what the deterministic lookup returns for a value in THIS account (read-only; it
 * sends nothing and reads no contact). Lets an admin check how a Producto value will resolve before a Flow uses it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return guarded('read', async ({ account, db }) => {
    const value = new URL(request.url).searchParams.get('value')
    try {
      const found = await lookupProductAudios({ db, accountId: account.accountId, productValue: value })
      if (found.kind !== 'ready') return json(found)
      return json({
        kind: 'ready',
        product: found.product,
        items: found.items.map((i) => ({ id: i.itemId, position: i.position, sha256: i.sha256, url: i.url, bytes: i.bytes, duration_ms: i.durationMs, pre_delay_seconds: i.preDelaySeconds })),
      })
    } catch (err) {
      if (err instanceof CatalogLookupError) return json({ error: 'lookup_failed' }, 500)
      throw err
    }
  })
}
