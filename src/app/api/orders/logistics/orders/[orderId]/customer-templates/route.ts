import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authorize, readJsonObject, respond } from '@/lib/orders/logistics/http'
import { resolveOrderCustomerTemplate, sendOrderCustomerTemplate } from '@/lib/orders/logistics/customer-templates'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export async function POST(request:Request,{params}:{params:Promise<{orderId:string}>}){
  try{
    const auth=await authorize()
    if(!auth.ok)return auth.response
    const limit=checkRateLimit(`order-customer-template:${auth.ctx.userId}`,{limit:30,windowMs:60_000})
    if(!limit.success)return rateLimitResponse(limit) as NextResponse
    const body=await readJsonObject(request)
    if(!body)return NextResponse.json({error:'invalid_body'},{status:400})
    const {orderId}=await params
    const admin=supabaseAdmin()
    if(body.action==='send_summary')return respond(await sendOrderCustomerTemplate(auth.ctx,admin,orderId,'summary'))
    if(body.action==='send_voucher')return respond(await sendOrderCustomerTemplate(auth.ctx,admin,orderId,'voucher'))
    if(body.action==='resolve')return respond(await resolveOrderCustomerTemplate(auth.ctx,admin,body.dispatch_id,body.resolution))
    return NextResponse.json({error:'invalid_action'},{status:400})
  }catch(error){
    return toErrorResponse(error)
  }
}
