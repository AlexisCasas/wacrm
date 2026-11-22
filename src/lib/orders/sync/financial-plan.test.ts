import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script=resolve(process.cwd(),'scripts/qa/order-sync/plan-financial.cjs')
const A='11111111-1111-4111-8111-111111111111'
const row=(id:string,over:Record<string,unknown>={})=>({
  canonical_order_id:id,total:100,paid_confirmed:0,balance:100,financial_status:'unpaid',tracked:true,...over
})
function run(w:unknown[],i:unknown[]){
  const d=mkdtempSync(join(tmpdir(),'sync03b-')); const wf=join(d,'w.json'), inf=join(d,'i.json'), out=join(d,'o.json')
  writeFileSync(wf,JSON.stringify(w)); writeFileSync(inf,JSON.stringify(i))
  execFileSync(process.execPath,[script,'--wacrm',wf,'--inkaclick',inf,'--out',out],{env:{...process.env,SYNC_FINANCIAL_PLAN_READ_ONLY:'1'}})
  return JSON.parse(readFileSync(out,'utf8'))
}
describe('SYNC-03B financial planner',()=>{
  it('MATCH when equal',()=>expect(run([row(A)],[row(A)]).orders[0].status).toBe('MATCH'))
  it('never treats untracked WACRM as zero',()=>expect(run([row(A,{tracked:false,paid_confirmed:null,balance:null,financial_status:'not_tracked'})],[row(A,{paid_confirmed:30,balance:70,financial_status:'partially_paid'})]).orders[0]).toMatchObject({status:'INKACLICK_AHEAD',action:'IMPORT_REVIEW_REQUIRED'}))
  it('flags total mismatch as conflict',()=>expect(run([row(A)],[row(A,{total:120,balance:120})]).orders[0]).toMatchObject({status:'CONFLICT',action:'REVIEW_REQUIRED'}))
  it('plans WACRM export only for monotonic higher paid',()=>expect(run([row(A,{paid_confirmed:30,balance:70,financial_status:'partially_paid'})],[row(A)]).orders[0]).toMatchObject({status:'WACRM_AHEAD',action:'EXPORT_FINANCIAL_EVENT'}))
  it('plans InkaClick import only for monotonic higher paid',()=>expect(run([row(A)],[row(A,{paid_confirmed:30,balance:70,financial_status:'partially_paid'})]).orders[0]).toMatchObject({status:'INKACLICK_AHEAD',action:'IMPORT_FINANCIAL_EVENT'}))
  it('fails closed on non-monotonic divergence',()=>expect(run([row(A,{paid_confirmed:40,balance:70})],[row(A,{paid_confirmed:30,balance:60})]).orders[0]).toMatchObject({status:'CONFLICT',action:'REVIEW_REQUIRED'}))
  it('is file-only and requires explicit read-only mode',()=>{
    const d=mkdtempSync(join(tmpdir(),'sync03b-')); const wf=join(d,'w.json'), inf=join(d,'i.json')
    writeFileSync(wf,'[]'); writeFileSync(inf,'[]')
    expect(()=>execFileSync(process.execPath,[script,'--wacrm',wf,'--inkaclick',inf],{env:{...process.env,SYNC_FINANCIAL_PLAN_READ_ONLY:''},stdio:'pipe'})).toThrow()
  })
})
