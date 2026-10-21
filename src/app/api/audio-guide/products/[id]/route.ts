import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, notFound, validId, productDetailDto } from '@/lib/audio-guide/api'
import { deleteProduct, getProduct, saveProduct } from '@/lib/audio-guide/catalog'
import { parseRevision, parseSaveProduct } from '@/lib/audio-guide/input'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/audio-guide/products/:id — the product with its audios, in playing order. */
export async function GET(_request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params
  if (!validId(id)) return notFound()
  return guarded('read', async ({ account, db }) => {
    const result = await getProduct(db, account.accountId, id)
    return result.ok ? json({ product: productDetailDto(result.value) }) : failure(result)
  })
}

/** PATCH /api/audio-guide/products/:id { expected_revision, display_name?, product_value?, active? } — admin. */
export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params
  if (!validId(id)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const parsed = parseSaveProduct(await request.json().catch(() => null))
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    const saved = await saveProduct(db, account.accountId, id, parsed.value)
    if (!saved.ok) return failure(saved)
    const fresh = await getProduct(db, account.accountId, id)
    return fresh.ok ? json({ product: productDetailDto(fresh.value) }) : failure(fresh)
  })
}

/** DELETE /api/audio-guide/products/:id?expected_revision=N — admin. Removes the product and its audios; history and stored files stay. */
export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { id } = await params
  if (!validId(id)) return notFound()
  return guarded('write', async ({ account, db }) => {
    const revision = parseRevision(new URL(request.url).searchParams.get('expected_revision'))
    if (!revision.ok) return badRequest(revision.field, revision.error)
    const result = await deleteProduct(db, account.accountId, id, revision.value)
    return result.ok ? json({ deleted: true }) : failure(result)
  })
}
