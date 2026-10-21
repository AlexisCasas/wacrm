import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, notFound, validId, productDetailDto } from '@/lib/audio-guide/api'
import { getProduct, removeItem, updateItem } from '@/lib/audio-guide/catalog'
import { parseRevision, parseUpdateItem } from '@/lib/audio-guide/input'

type Ctx = { params: Promise<{ id: string; itemId: string }> }

/** PATCH /api/audio-guide/products/:id/items/:itemId { expected_revision, status?, pre_delay_seconds?, label? } — admin. The file itself can never change. */
export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id, itemId } = await params
  if (!validId(id) || !validId(itemId)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const parsed = parseUpdateItem(await request.json().catch(() => null))
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    const updated = await updateItem(db, account.accountId, itemId, parsed.value)
    if (!updated.ok) return failure(updated)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value) }) : failure(fresh)
  })
}

/** DELETE /api/audio-guide/products/:id/items/:itemId?expected_revision=N — admin. Removes the association only; the stored file and past sends stay. */
export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id, itemId } = await params
  if (!validId(id) || !validId(itemId)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const revision = parseRevision(new URL(request.url).searchParams.get('expected_revision'))
    if (!revision.ok) return badRequest(revision.field, revision.error)
    const removed = await removeItem(db, account.accountId, itemId, revision.value)
    if (!removed.ok) return failure(removed)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value) }) : failure(fresh)
  })
}
