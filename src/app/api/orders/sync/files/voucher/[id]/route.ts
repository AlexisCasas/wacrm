import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'

function authorized(request: Request): boolean {
  const expected = process.env.ORDER_SYNC_TOKEN?.trim()
  if (!expected) return false
  const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a,b)
}

export async function GET(request: Request,{params}:{params:Promise<{id:string}>}) {
  if (process.env.ORDER_SYNC_ENABLED !== 'true' || !process.env.ORDER_SYNC_TOKEN?.trim()) {
    return NextResponse.json({code:'not_configured'},{status:503})
  }
  if (!authorized(request)) return NextResponse.json({code:'unauthorized'},{status:401})

  const {id}=await params
  const admin=supabaseAdmin()
  const {data:doc,error}=await admin
    .from('order_documents')
    .select('id,storage_path,mime_type,size_bytes,content_hash,source,status,kind')
    .eq('id',id)
    .eq('kind','voucher')
    .eq('status','validated')
    .neq('source','sync')
    .maybeSingle()

  if (error) return NextResponse.json({code:'internal_error'},{status:500})
  if (!doc) return NextResponse.json({code:'not_found'},{status:404})

  const {data:file,error:downloadError}=await admin.storage.from(ORDER_DOCS_BUCKET).download(doc.storage_path as string)
  if (downloadError || !file) return NextResponse.json({code:'storage_failed'},{status:502})

  const bytes=new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength !== Number(doc.size_bytes)) return NextResponse.json({code:'size_mismatch'},{status:500})
  const hash=createHash('sha256').update(bytes).digest('hex')
  if (hash !== doc.content_hash) return NextResponse.json({code:'hash_mismatch'},{status:500})

  return new Response(bytes,{
    status:200,
    headers:{
      'content-type':String(doc.mime_type),
      'content-length':String(bytes.byteLength),
      'x-content-sha256':hash,
      'cache-control':'no-store',
    },
  })
}
