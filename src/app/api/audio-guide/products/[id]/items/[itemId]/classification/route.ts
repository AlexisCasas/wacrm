import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, notFound, validId, productDetailDto } from '@/lib/audio-guide/api'
import { classifyItem, getProduct } from '@/lib/audio-guide/catalog'
import { parseClassification } from '@/lib/audio-guide/input'

type Ctx = { params: Promise<{ id: string; itemId: string }> }

/**
 * PUT /api/audio-guide/products/:id/items/:itemId/classification { expected_revision, purpose_id, identifier_id } — admin.
 * Both ids (this account's, active) or both null to clear. 409 duplicate_classification (with conflict_item) when another audio of the
 * product - active or not - already has the pair; 409 revision_conflict when the product changed. The file is never touched.
 */
export async function PUT(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id, itemId } = await params
  if (!validId(id) || !validId(itemId)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const parsed = parseClassification(await request.json().catch(() => null))
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    // The audio must belong to the product in the path (and to this account): the answer is that product, refreshed.
    const { data: owned, error: ownedError } = await db.from('audio_guide_items').select('id').eq('id', itemId).eq('product_id', id).eq('account_id', account.accountId).maybeSingle()
    if (ownedError) return json({ error: 'internal_error' }, 500)
    if (!owned) return notFound()
    const result = await classifyItem(db, account.accountId, itemId, parsed.value)
    if (!result.ok) return failure(result)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value) }) : failure(fresh)
  })
}
