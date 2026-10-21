import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, notFound, validId, productDetailDto } from '@/lib/audio-guide/api'
import { getProduct, reorderItems } from '@/lib/audio-guide/catalog'
import { parseReorder } from '@/lib/audio-guide/input'

type Ctx = { params: Promise<{ id: string }> }

/** PUT /api/audio-guide/products/:id/order { expected_revision, item_ids: [...] } — admin. item_ids must be exactly the product's audios, in the new order. */
export async function PUT(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params
  if (!validId(id)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const parsed = parseReorder(await request.json().catch(() => null))
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    const reordered = await reorderItems(db, account.accountId, id, parsed.value.expectedRevision, parsed.value.itemIds)
    if (!reordered.ok) return failure(reordered)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value) }) : failure(fresh)
  })
}
