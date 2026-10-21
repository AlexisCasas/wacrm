import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, notFound, validId, productDetailDto } from '@/lib/audio-guide/api'
import { addItem, getProduct } from '@/lib/audio-guide/catalog'
import { parseAddItem } from '@/lib/audio-guide/input'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/audio-guide/products/:id/items { expected_revision, path | sha256, label?, pre_delay_seconds? } — admin.
 * `path` is a file the editor staged in this account (verified and stored now); `sha256` is a voice note already stored for it. A URL is
 * never accepted. The audio is appended at the end of the product's sequence (at most six).
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params
  if (!validId(id)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const parsed = parseAddItem(await request.json().catch(() => null), account.accountId)
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    const added = await addItem(db, account.accountId, id, parsed.value)
    if (!added.ok) return failure(added)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value), item_id: added.value.itemId }, 201) : failure(fresh)
  })
}
