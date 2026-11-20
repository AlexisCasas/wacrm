import { describe, expect, it } from 'vitest'

import { buildTemplateBodyParams, TEMPLATE_PARAM_FIELDS, type OrderForTemplate } from '@/lib/orders/logistics/template-params'
import { computePendingBalance, formatSoles } from '@/lib/orders/payments/balance'

const order = (over: Partial<OrderForTemplate> = {}): OrderForTemplate => ({
  customer_name: 'Cliente Prueba', product_summary: 'taladro inalámbrico', quantity: 1, total: 150, destination: 'Arequipa', seller_name: 'Vendedor', dni: '12345678', ...over,
})

describe('pending balance arithmetic (PR-06: total - confirmed payments, never negative)', () => {
  it.each([
    [150, 0, 150], [150, 50, 100], [150, 149.99, 0.01], [150, 150, 0], [150, 200, 0], [0, 0, 0], [99.995, 0, 100], [100, 33.33, 66.67],
  ])('total %f paid %f -> pending %f', (total, paid, expected) => {
    expect(computePendingBalance(total, paid)).toBe(expected)
  })

  it('a non-finite input is never a made-up balance', () => {
    expect(computePendingBalance(Number.NaN, 0)).toBe(0)
    expect(computePendingBalance(100, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('formats the exact text a template variable carries, and never a negative amount', () => {
    expect(formatSoles(150)).toBe('S/ 150.00')
    expect(formatSoles(0.5)).toBe('S/ 0.50')
    expect(formatSoles(-20)).toBe('S/ 0.00')
  })
})

describe('template variables for the balance / payment instructions', () => {
  it('pending_balance and payment_instructions are supported variable fields', () => {
    expect(TEMPLATE_PARAM_FIELDS).toContain('pending_balance')
    expect(TEMPLATE_PARAM_FIELDS).toContain('payment_instructions')
  })

  it('fills the balance variant: name, product, destination, balance (+ instructions) in the configured order', () => {
    const out = buildTemplateBodyParams(order({ pending_balance: 'S/ 100.00', payment_instructions: 'Paga por Yape o transferencia y envía el comprobante' }), ['customer_name', 'product', 'destination', 'pending_balance', 'payment_instructions'])
    expect(out).toEqual({ ok: true, params: ['Cliente Prueba', 'taladro inalámbrico', 'Arequipa', 'S/ 100.00', 'Paga por Yape o transferencia y envía el comprobante'] })
  })

  it('a NOT AVAILABLE balance (null) is refused: it is never turned into zero, an empty value or the "-" fallback', () => {
    for (const missing of [undefined, null]) {
      expect(buildTemplateBodyParams(order({ pending_balance: missing }), ['customer_name', 'pending_balance'])).toEqual({ ok: false, error: 'pending_balance_unavailable' })
    }
    // zero IS a real balance (tracked and fully paid): it is formatted, not refused
    expect(buildTemplateBodyParams(order({ pending_balance: 'S/ 0.00' }), ['pending_balance'])).toEqual({ ok: true, params: ['S/ 0.00'] })
  })

  it('missing payment instructions are refused too (an account that did not configure them sends nothing that needs them)', () => {
    expect(buildTemplateBodyParams(order({ payment_instructions: null }), ['payment_instructions'])).toEqual({ ok: false, error: 'payment_instructions_not_configured' })
  })

  it('a field outside the supported list is still an invalid configuration', () => {
    expect(buildTemplateBodyParams(order(), ['customer_name', 'bank_account'])).toEqual({ ok: false, error: 'invalid_params_config' })
  })

  it('multi-line payment instructions are flattened into one line (Meta rejects newlines in a parameter)', () => {
    const out = buildTemplateBodyParams(order({ payment_instructions: 'Línea 1\nLínea 2\t  fin' }), ['payment_instructions'])
    expect(out).toEqual({ ok: true, params: ['Línea 1 Línea 2 fin'] })
  })

  it('the shalom guide variables (voucher notice) need a registered guide', () => {
    expect(buildTemplateBodyParams(order({ shalom_number: '12345678', shalom_code: 'AB12' }), ['shalom_number', 'shalom_code'])).toEqual({ ok: true, params: ['12345678', 'AB12'] })
    expect(buildTemplateBodyParams(order({ shalom_number: '12345678' }), ['shalom_number', 'shalom_code'])).toEqual({ ok: false, error: 'shalom_guide_unavailable' })
  })

  it('the customer-facing variants designed for WACRM never include the DNI number', () => {
    const recommended = {
      packaging_paid: ['customer_name', 'product', 'destination'],
      packaging_balance: ['customer_name', 'product', 'destination', 'pending_balance'],
      arrival_paid: ['customer_name', 'product', 'destination'],
      arrival_balance: ['customer_name', 'product', 'destination', 'pending_balance', 'payment_instructions'],
      voucher: ['customer_name', 'shalom_number', 'shalom_code', 'destination'],
    }
    for (const fields of Object.values(recommended)) expect(fields).not.toContain('dni')
    // ... and the DNI value is not reachable from any of them
    const out = buildTemplateBodyParams(order({ pending_balance: 'S/ 1.00', payment_instructions: 'x', shalom_number: '1', shalom_code: 'A' }), recommended.arrival_balance)
    expect(JSON.stringify(out)).not.toContain('12345678')
  })
})
