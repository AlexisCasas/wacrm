import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(process.cwd(),'supabase/migrations/20261205000010_order_sync_voucher_parity.sql'),'utf8').replace(/\r\n/g,'\n')
const code = sql.replace(/^\s*--.*$/gm,'')

describe('SYNC-06 WACRM voucher parity',()=>{
  it('adds an explicit sync document source instead of inventing a human actor',()=>{
    expect(code).toMatch(/source IN \('upload', 'chat_message', 'sync'\)/)
    expect(code).toMatch(/source = 'sync'[\s\S]*uploaded_by IS NULL[\s\S]*validated_by IS NULL/)
    expect(code).toMatch(/ALTER COLUMN uploaded_by DROP NOT NULL/)
  })

  it('local validation emits only PII-free voucher metadata',()=>{
    expect(code).toMatch(/'voucher\.validated'/)
    expect(code).toMatch(/'source_document_id'/)
    expect(code).toMatch(/'content_hash'/)
    expect(code).not.toMatch(/reviewed_data\s*\)/)
    expect(code).not.toMatch(/'dni'|'phone'|'name'/i)
  })

  it('imported sync vouchers cannot bounce back',()=>{
    expect(code).toMatch(/NEW\.source = 'sync'/)
  })

  it('registers imports idempotently and refuses late replacement while packing',()=>{
    expect(code).toMatch(/sync:inkaclick:voucher:/)
    expect(code).toMatch(/l\.status IN \('packing','ready_for_dispatch'\)/)
    expect(code).toMatch(/sync_identity_conflict/)
  })

  it('writer stays service-role only',()=>{
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.register_synced_order_voucher[\s\S]*TO service_role;/)
  })
})
