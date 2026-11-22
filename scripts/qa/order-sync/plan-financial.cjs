#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function die(msg){ process.stderr.write(`financial-plan: ${msg}\n`); process.exit(2) }
function money(v){ if(v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)?Math.round(n*100)/100:null }
function load(file){ const v=JSON.parse(fs.readFileSync(file,'utf8')); if(!Array.isArray(v)) die(`${file}: expected JSON array`); return v }
function index(rows){
  const m=new Map()
  for(const r of rows){
    const id=r.canonical_order_id
    if(!id) continue
    if(m.has(id)) die(`duplicate canonical_order_id ${id}`)
    m.set(id,r)
  }
  return m
}
function normalize(r){
  if(!r) return null
  return {
    id:r.canonical_order_id,
    tracked:r.tracked===true,
    total:money(r.total),
    paid:money(r.paid_confirmed),
    balance:money(r.balance),
    status:r.financial_status ?? null
  }
}
function classify(wRaw,iRaw){
  if(!wRaw && !iRaw) throw new Error('both sides missing')
  if(!wRaw) return {status:'MISSING_IN_WACRM',action:'REVIEW_REQUIRED',reason:'canonical order absent from WACRM snapshot'}
  if(!iRaw) return {status:'MISSING_IN_INKACLICK',action:'REVIEW_REQUIRED',reason:'canonical order absent from InkaClick snapshot'}
  const w=normalize(wRaw), i=normalize(iRaw)

  if(w.total===null || i.total===null) return {status:'CONFLICT',action:'REVIEW_REQUIRED',reason:'missing total'}
  if(w.total!==i.total) return {status:'CONFLICT',action:'REVIEW_REQUIRED',reason:'total mismatch'}

  if(!w.tracked && i.tracked){
    return {
      status:'INKACLICK_AHEAD',
      action:'IMPORT_REVIEW_REQUIRED',
      reason:'WACRM financial axis is not tracked; InkaClick aggregate must not be invented as a zero payment'
    }
  }
  if(w.tracked && !i.tracked){
    return {status:'WACRM_AHEAD',action:'EXPORT_REVIEW_REQUIRED',reason:'InkaClick financial axis is not tracked'}
  }
  if(!w.tracked && !i.tracked) return {status:'MATCH',action:'NONE',reason:'both sides untracked'}

  if(w.paid===null || i.paid===null || w.balance===null || i.balance===null)
    return {status:'CONFLICT',action:'REVIEW_REQUIRED',reason:'tracked side missing paid or balance'}

  if(w.paid===i.paid && w.balance===i.balance)
    return {status:'MATCH',action:'NONE',reason:'financial snapshot matches'}

  if(w.paid>i.paid && w.balance<i.balance)
    return {status:'WACRM_AHEAD',action:'EXPORT_FINANCIAL_EVENT',reason:'WACRM has the greater paid amount on the same total'}

  if(i.paid>w.paid && i.balance<w.balance)
    return {status:'INKACLICK_AHEAD',action:'IMPORT_FINANCIAL_EVENT',reason:'InkaClick has the greater paid amount on the same total'}

  return {status:'CONFLICT',action:'REVIEW_REQUIRED',reason:'non-monotonic financial divergence'}
}

function plan(wRows,iRows){
  const w=index(wRows), i=index(iRows)
  const ids=[...new Set([...w.keys(),...i.keys()])].sort()
  const orders=ids.map(id=>({canonical_order_id:id,...classify(w.get(id),i.get(id))}))
  const counts={}
  for(const o of orders) counts[o.status]=(counts[o.status]??0)+1
  return {schema_version:1,read_only:true,counts,orders}
}

function parse(argv){
  const a={}
  for(let n=0;n<argv.length;n+=2){ const k=argv[n],v=argv[n+1]; if(!['--wacrm','--inkaclick','--out'].includes(k)||!v) die('usage: plan-financial.cjs --wacrm w.json --inkaclick i.json [--out plan.json]'); a[k.slice(2)]=v }
  if(!a.wacrm||!a.inkaclick) die('usage: plan-financial.cjs --wacrm w.json --inkaclick i.json [--out plan.json]')
  return a
}
function regular(p){
  if(/^[a-z]+:\/\//i.test(p)) die('network/database URLs are forbidden')
  const r=path.resolve(p), s=fs.statSync(r)
  if(!s.isFile()) die(`${p}: not a regular file`)
  return r
}
if(require.main===module){
  if(process.env.SYNC_FINANCIAL_PLAN_READ_ONLY!=='1') die('set SYNC_FINANCIAL_PLAN_READ_ONLY=1')
  const a=parse(process.argv.slice(2))
  const out=plan(load(regular(a.wacrm)),load(regular(a.inkaclick)))
  if(a.out) fs.writeFileSync(path.resolve(a.out),JSON.stringify(out,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stdout.write(JSON.stringify(out.counts)+'\n')
}
module.exports={classify,plan}
