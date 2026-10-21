import { NextResponse } from 'next/server'
import { guarded, json, failure, badRequest, productSummaryDto, productDetailDto } from '@/lib/audio-guide/api'
import { createProduct, listProducts } from '@/lib/audio-guide/catalog'
import { parseCreateProduct } from '@/lib/audio-guide/input'

/** GET /api/audio-guide/products?q=  — the account's products with their audio counts. */
export async function GET(request: Request): Promise<NextResponse> {
  return guarded('read', async ({ account, db }) => {
    const q = new URL(request.url).searchParams.get('q') ?? undefined
    const result = await listProducts(db, account.accountId, q)
    return result.ok ? json({ products: result.value.map(productSummaryDto) }) : failure(result)
  })
}

/** POST /api/audio-guide/products  { display_name, product_value? }  — admin. product_value is what the contact's Producto field holds. */
export async function POST(request: Request): Promise<NextResponse> {
  return guarded('write', async ({ account, db }) => {
    const parsed = parseCreateProduct(await request.json().catch(() => null))
    if (!parsed.ok) return badRequest(parsed.field, parsed.error)
    const result = await createProduct(db, account.accountId, parsed.value)
    return result.ok ? json({ product: productDetailDto(result.value) }, 201) : failure(result)
  })
}
