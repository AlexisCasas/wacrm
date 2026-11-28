import type { SupabaseClient } from '@supabase/supabase-js'

import { ForbiddenError } from '@/lib/auth/account'
import { assertConversationOperationalAccess } from '@/lib/conversations/operational-access'
import { CONFIRMED_ITEM_COLUMNS, CONFIRMED_ORDER_COLUMNS, toOrder } from '@/lib/orders/confirmed-orders'
import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import { ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { resolveOrderBalance, formatSoles, balanceErrorCode } from '@/lib/orders/payments/balance'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { extractVariableIndices } from '@/lib/whatsapp/template-validators'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

type Kind = 'summary' | 'voucher'
type SendFn = typeof sendMessageToConversation

export interface CustomerTemplateDeps { sendMessage?: SendFn }

export interface CustomerTemplateResult {
  dispatch_id: string
  status: 'sent' | 'failed' | 'uncertain'
  attempt?: number
}

interface Claim {
  dispatch_id: string
  attempt: number
  conversation_id: string
  voucher_document_id: string
  template_name: string
  template_language: string
}

const parseClaim=(o:Record<string,unknown>):Claim=>({
  dispatch_id:String(o.dispatch_id),
  attempt:Number(o.attempt??1),
  conversation_id:String(o.conversation_id),
  voucher_document_id:String(o.voucher_document_id),
  template_name:String(o.template_name),
  template_language:String(o.template_language),
})

const reasonStatus:Record<string,number>={
  voucher_required:409,template_not_configured:409,order_without_conversation:409,
  already_sent:409,in_progress:409,uncertain:409,
}

const text=(v:unknown):string|null=>typeof v==='string'&&v.trim()?v.trim():null
const lineSummary=(items:Array<{quantity:number;product_name:string}>)=>items.map(i=>`${i.quantity} × ${i.product_name}`).join(' · ')

async function claim(admin:SupabaseClient,ctx:Pick<LogisticsCaller,'accountId'|'userId'>,orderId:string,kind:Kind):Promise<ServiceResult<Claim>>{
  const {data,error}=await admin.rpc('begin_order_customer_template',{p_account:ctx.accountId,p_actor:ctx.userId,p_order:orderId,p_kind:kind})
  if(error)return mapRpcError(error)
  const out=(data??{}) as Record<string,unknown>&{ok?:boolean;reason?:string}
  if(out.ok!==true)return fail(reasonStatus[String(out.reason??'')]??409,String(out.reason??'rejected'),out.dispatch_id?{dispatch_id:out.dispatch_id}:undefined)
  return {ok:true,status:200,body:parseClaim(out)}
}

async function finish(admin:SupabaseClient,ctx:Pick<LogisticsCaller,'accountId'|'userId'>,id:string,outcome:'sent'|'failed'|'uncertain',extra:{messageRow?:string;wamid?:string;code?:string}={}){
  return admin.rpc('finish_order_customer_template',{
    p_account:ctx.accountId,p_actor:ctx.userId,p_dispatch:id,p_outcome:outcome,
    p_message_row:extra.messageRow??null,p_wamid:extra.wamid??null,p_error_code:extra.code??null,
  })
}

export async function sendOrderCustomerTemplate(
  ctx:Pick<LogisticsCaller,'supabase'|'accountId'|'userId'>,
  admin:SupabaseClient,
  orderId:string,
  kind:Kind,
  deps:CustomerTemplateDeps={},
):Promise<ServiceResult<CustomerTemplateResult>>{
  if(!isUuid(orderId))return fail(400,'invalid_order_id')
  if(kind!=='summary'&&kind!=='voucher')return fail(400,'invalid_kind')
  const c=await claim(admin,ctx,orderId,kind)
  if(!c.ok)return c
  const claimed=c.body

  const preFail=async(code:string,status=409):Promise<ServiceResult<CustomerTemplateResult>>=>{
    await finish(admin,ctx,claimed.dispatch_id,'failed',{code})
    return fail(status,code,{dispatch_id:claimed.dispatch_id})
  }

  const resolved=await resolveTemplateRow(admin,ctx.accountId,claimed.template_name,claimed.template_language)
  if(resolved.malformed)return preFail('template_malformed')
  const template=resolved.row as {status?:string;header_type?:string|null;body_text:string}|null
  if(!template)return preFail('template_not_found')
  if(String(template.status??'').toUpperCase()!=='APPROVED')return preFail('template_not_approved')
  if(kind==='summary'&&template.header_type)return preFail('template_header_mismatch')
  if(kind==='voucher'&&String(template.header_type??'').toLowerCase()!=='image')return preFail('template_header_mismatch')

  const [orderRes,itemRes,docRes,balance]=await Promise.all([
    admin.from('order_confirmations').select(`${CONFIRMED_ORDER_COLUMNS},dni`).eq('account_id',ctx.accountId).eq('id',orderId).maybeSingle(),
    admin.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id',ctx.accountId).eq('order_id',orderId).order('line_number',{ascending:true}),
    admin.from('order_documents').select('id,status,kind,storage_path,mime_type,reviewed_data').eq('account_id',ctx.accountId).eq('id',claimed.voucher_document_id).maybeSingle(),
    resolveOrderBalance(admin,ctx.accountId,orderId),
  ])
  if(orderRes.error||itemRes.error||docRes.error||!orderRes.data||!docRes.data)return preFail('internal_error',500)
  const doc=docRes.data as {id:string;status:string;kind:string;storage_path:string;mime_type:string;reviewed_data:Record<string,unknown>|null}
  if(doc.kind!=='voucher'||doc.status!=='validated')return preFail('voucher_required')
  const order=toOrder(orderRes.data as unknown as Parameters<typeof toOrder>[0],(itemRes.data??[]) as unknown as Parameters<typeof toOrder>[1])
  const reviewed=doc.reviewed_data??{}
  const dni=text(reviewed.dni)??text((orderRes.data as {dni?:unknown}).dni)
  const shalomNumber=text(reviewed.shalom_number)
  const shalomCode=text(reviewed.shalom_code)
  const destination=text(reviewed.destination)??order.destination
  if(!dni||!shalomNumber||!shalomCode||!destination)return preFail('voucher_data_incomplete')
  if(!balance.available)return preFail(balanceErrorCode(balance.reason),balance.reason==='lookup_failed'?500:409)

  try{
    await assertConversationOperationalAccess(ctx.supabase,ctx.accountId,claimed.conversation_id)
  }catch(error){
    return preFail(error instanceof ForbiddenError?'conversation_forbidden':'access_check_failed',error instanceof ForbiddenError?403:500)
  }

  let params:string[]
  let headerMediaUrl:string|undefined
  if(kind==='summary'){
    params=[
      order.customer_name,order.customer_name,dni,destination,lineSummary(order.lines),
      formatSoles(balance.total),formatSoles(balance.paid),formatSoles(balance.pending),
      shalomNumber,shalomCode,
    ]
    if(extractVariableIndices(template.body_text).length!==params.length)return preFail('template_params_mismatch')
  }else{
    params=[order.customer_name,order.customer_name,destination]
    if(extractVariableIndices(template.body_text).length!==params.length)return preFail('template_params_mismatch')
    if(!doc.mime_type.startsWith('image/'))return preFail('voucher_image_required',409)
    const {data:signed,error:signError}=await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(doc.storage_path,600)
    if(signError||!signed?.signedUrl)return preFail('storage_failed',502)
    headerMediaUrl=signed.signedUrl
  }

  const {data:marked,error:markError}=await admin.rpc('mark_order_customer_template_sending',{p_account:ctx.accountId,p_actor:ctx.userId,p_dispatch:claimed.dispatch_id})
  if(markError||(marked as {ok?:boolean}|null)?.ok!==true)return preFail('claim_lost')

  const send=deps.sendMessage??sendMessageToConversation
  try{
    const sent=await send(ctx.supabase,ctx.accountId,{
      conversationId:claimed.conversation_id,
      messageType:'template',
      templateName:claimed.template_name,
      templateLanguage:resolved.language,
      templateParams:params,
      templateMessageParams:{body:params,...(headerMediaUrl?{headerMediaUrl}:{})},
      origin:'manual_reply',
      actor:{userId:ctx.userId},
      senderId:ctx.userId,
    })
    const done=await finish(admin,ctx,claimed.dispatch_id,'sent',{messageRow:sent.messageId,wamid:sent.whatsappMessageId})
    if(done.error)return fail(500,'dispatch_record_failed',{dispatch_id:claimed.dispatch_id,status:'uncertain'})
    return {ok:true,status:200,body:{dispatch_id:claimed.dispatch_id,status:'sent',attempt:claimed.attempt}}
  }catch(error){
    const uncertain=error instanceof Error&&/failed to save to DB|timeout|ECONNRESET|aborted/i.test(error.message)
    const outcome=uncertain?'uncertain':'failed'
    await finish(admin,ctx,claimed.dispatch_id,outcome,{code:uncertain?'send_uncertain':'send_failed'})
    return fail(uncertain?409:502,uncertain?'send_uncertain':'send_failed',{dispatch_id:claimed.dispatch_id,status:outcome})
  }
}

export async function resolveOrderCustomerTemplate(
  ctx:Pick<LogisticsCaller,'accountId'|'userId'>,
  admin:SupabaseClient,
  dispatchId:unknown,
  resolution:unknown,
):Promise<ServiceResult<{status:string}>>{
  if(!isUuid(dispatchId))return fail(400,'invalid_dispatch_id')
  if(resolution!=='confirmed_sent'&&resolution!=='confirmed_not_sent')return fail(400,'invalid_resolution')
  const {data,error}=await admin.rpc('resolve_order_customer_template',{p_account:ctx.accountId,p_actor:ctx.userId,p_dispatch:dispatchId,p_resolution:resolution})
  if(error)return mapRpcError(error)
  const out=(data??{}) as {ok?:boolean;reason?:string;status?:string}
  return out.ok===true?{ok:true,status:200,body:{status:out.status??'failed'}}:fail(409,out.reason??'rejected')
}
