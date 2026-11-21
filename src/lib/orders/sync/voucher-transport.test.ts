import { describe,expect,it } from 'vitest'
import { parseVoucherValidatedPayload } from './voucher-transport'

describe('voucher sync payload',()=>{
  it('accepts only the PII-free voucher contract',()=>{
    expect(parseVoucherValidatedPayload({
      source_voucher_id:'11111111-1111-4111-8111-111111111111',
      shalom_number:'104889750',
      shalom_code:'MDDW',
      freight_amount:15,
      mime_type:'application/pdf',
      size_bytes:100,
      content_hash:'a'.repeat(64),
    })).not.toBeNull()
  })
  it('rejects customer data and malformed hashes',()=>{
    expect(parseVoucherValidatedPayload({
      source_voucher_id:'11111111-1111-4111-8111-111111111111',
      shalom_number:'104889750',shalom_code:'MDDW',dni:'12345678',
    })).toBeNull()
    expect(parseVoucherValidatedPayload({
      source_voucher_id:'11111111-1111-4111-8111-111111111111',
      shalom_number:'104889750',shalom_code:'MDDW',content_hash:'bad',
    })).toBeNull()
  })
})
