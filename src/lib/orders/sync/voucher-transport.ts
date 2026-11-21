import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { MAX_DOCUMENT_BYTES, ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'
import { buildDocumentPath, isAllowedMime, safeFileName, sha256Hex, sniffMime } from '@/lib/orders/logistics/files'

export interface VoucherValidatedPayload {
  source_voucher_id: string
  shalom_number: string
  shalom_code: string
  freight_amount?: number | null
  mime_type?: string | null
  size_bytes?: number | null
  content_hash?: string | null
}

export interface RemoteVoucherEnvelope {
  origin_event_id: string
  canonical_order_id: string
  occurred_at: string
  payload: VoucherValidatedPayload
}

export type VoucherApplyResult =
  | { ok: true; status: 200; changed: boolean }
  | { ok: false; status: 409 | 502 | 503; code: string }

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH=/^[0-9a-f]{64}$/

export function parseVoucherValidatedPayload(value: unknown): VoucherValidatedPayload | null {
  if(!value || typeof value!=='object' || Array.isArray(value)) return null
  const p=value as Record<string,unknown>
  const allowed=new Set(['source_voucher_id','shalom_number','shalom_code','freight_amount','mime_type','size_bytes','content_hash'])
  if(Object.keys(p).some(k=>!allowed.has(k))) return null
  if(typeof p.source_voucher_id!=='string' || !UUID.test(p.source_voucher_id)) return null
  if(typeof p.shalom_number!=='string' || !p.shalom_number.trim() || p.shalom_number.length>80) return null
  if(typeof p.shalom_code!=='string' || !p.shalom_code.trim() || p.shalom_code.length>80) return null
  if(p.freight_amount!==undefined && p.freight_amount!==null && (typeof p.freight_amount!=='number' || !Number.isFinite(p.freight_amount) || p.freight_amount<0)) return null
  if(p.mime_type!==undefined && p.mime_type!==null && typeof p.mime_type!=='string') return null
  if(p.size_bytes!==undefined && p.size_bytes!==null && (typeof p.size_bytes!=='number' || !Number.isInteger(p.size_bytes) || p.size_bytes<=0 || p.size_bytes>MAX_DOCUMENT_BYTES)) return null
  if(p.content_hash!==undefined && p.content_hash!==null && (typeof p.content_hash!=='string' || !HASH.test(p.content_hash))) return null
  return {
    source_voucher_id:p.source_voucher_id,
    shalom_number:p.shalom_number.trim(),
    shalom_code:p.shalom_code.trim(),
    freight_amount:typeof p.freight_amount==='number'?p.freight_amount:null,
    mime_type:typeof p.mime_type==='string'?p.mime_type:null,
    size_bytes:typeof p.size_bytes==='number'?p.size_bytes:null,
    content_hash:typeof p.content_hash==='string'?p.content_hash:null,
  }
}

async function removeObject(admin:SupabaseClient,path:string){
  try{await admin.storage.from(ORDER_DOCS_BUCKET).remove([path])}catch{}
}

export async function applyInkaclickVoucherEvent(
  admin:SupabaseClient,
  event:RemoteVoucherEnvelope,
  env:NodeJS.ProcessEnv=process.env,
  fetchImpl:typeof fetch=fetch,
):Promise<VoucherApplyResult>{
  const fileUrl=env.INKACLICK_SYNC_VOUCHER_FILE_URL?.trim()
  const token=env.ORDER_SYNC_TOKEN?.trim()
  if(env.ORDER_SYNC_ENABLED!=='true' || !fileUrl || !token) return {ok:false,status:503,code:'voucher_sync_not_configured'}

  const p=event.payload
  const requestKey=`sync:inkaclick:voucher:${p.source_voucher_id}`

  const {data:existing,error:existingError}=await admin
    .from('order_documents')
    .select('id,order_id,content_hash,status')
    .eq('request_key',requestKey)
    .maybeSingle()
  if(existingError) return {ok:false,status:502,code:'document_lookup_failed'}
  if(existing){
    if(existing.order_id!==event.canonical_order_id) return {ok:false,status:409,code:'sync_identity_conflict'}
    return {ok:true,status:200,changed:false}
  }

  const {data:order,error:orderError}=await admin
    .from('order_confirmations')
    .select('id,account_id')
    .eq('id',event.canonical_order_id)
    .maybeSingle()
  if(orderError) return {ok:false,status:502,code:'order_lookup_failed'}
  if(!order) return {ok:false,status:409,code:'order_not_found'}

  const url=new URL(fileUrl)
  url.searchParams.set('voucher_id',p.source_voucher_id)
  let response:Response
  try{
    response=await fetchImpl(url,{
      method:'GET',
      headers:{authorization:`Bearer ${token}`},
      signal:AbortSignal.timeout(15_000),
    })
  }catch{
    return {ok:false,status:502,code:'source_file_unavailable'}
  }
  if(!response.ok) return {ok:false,status:502,code:'source_file_unavailable'}

  const bytes=new Uint8Array(await response.arrayBuffer())
  if(bytes.byteLength===0 || bytes.byteLength>MAX_DOCUMENT_BYTES) return {ok:false,status:409,code:'invalid_file_size'}
  if(p.size_bytes!==null && p.size_bytes!==undefined && bytes.byteLength!==p.size_bytes) return {ok:false,status:409,code:'file_size_mismatch'}

  const sniffed=sniffMime(bytes)
  if(!isAllowedMime(sniffed)) return {ok:false,status:409,code:'unsupported_file_type'}
  const declared=(response.headers.get('content-type')??'').split(';')[0].trim()
  if(declared && declared!==sniffed) return {ok:false,status:409,code:'file_mime_mismatch'}
  if(p.mime_type && p.mime_type!==sniffed) return {ok:false,status:409,code:'file_mime_mismatch'}

  const hash=sha256Hex(bytes)
  const headerHash=response.headers.get('x-content-sha256')
  if(headerHash && headerHash!==hash) return {ok:false,status:409,code:'file_hash_mismatch'}
  if(p.content_hash && p.content_hash!==hash) return {ok:false,status:409,code:'file_hash_mismatch'}

  const docId=randomUUID()
  const fileName=safeFileName('voucher-sync',sniffed)
  const path=buildDocumentPath({
    accountId:String(order.account_id),
    orderId:event.canonical_order_id,
    folder:'vouchers',
    documentId:docId,
    fileName,
  })

  const {error:uploadError}=await admin.storage.from(ORDER_DOCS_BUCKET).upload(path,bytes,{contentType:sniffed,upsert:false})
  if(uploadError) return {ok:false,status:502,code:'storage_failed'}

  const {data,error}=await admin.rpc('register_synced_order_voucher',{
    p_origin_event:event.origin_event_id,
    p_origin_document:p.source_voucher_id,
    p_order:event.canonical_order_id,
    p_doc:docId,
    p_storage_path:path,
    p_filename:fileName,
    p_mime:sniffed,
    p_size:bytes.byteLength,
    p_hash:hash,
    p_shalom_number:p.shalom_number,
    p_shalom_code:p.shalom_code,
    p_freight_amount:p.freight_amount??null,
    p_now:event.occurred_at,
  })

  if(error){
    await removeObject(admin,path)
    return {ok:false,status:502,code:'voucher_register_failed'}
  }
  const out=(data??{}) as {ok?:boolean;reason?:string;changed?:boolean}
  if(out.ok!==true){
    await removeObject(admin,path)
    const conflict=new Set(['order_locked','order_not_found','feature_disabled','sync_identity_conflict'])
    return {ok:false,status:conflict.has(out.reason??'')?409:502,code:out.reason??'voucher_register_failed'}
  }
  return {ok:true,status:200,changed:out.changed===true}
}
