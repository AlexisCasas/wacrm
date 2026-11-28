import { describe, expect, it } from 'vitest'

import { buildSummaryTemplateParams } from './customer-templates'

describe('buildSummaryTemplateParams', () => {
  it('keeps the approved 10-variable contract for the order summary', () => {
    expect(buildSummaryTemplateParams({
      customerName: 'Keyler Ortega',
      dni: '12345678',
      destination: 'Moquegua - Ilo - Ilo Puerto',
      items: [
        { quantity: 1, product_name: 'Guitarra Memphis' },
        { quantity: 1, product_name: 'Violin clásico' },
        { quantity: 1, product_name: 'capotraste' },
        { quantity: 1, product_name: 'afinador' },
      ],
      total: 580,
      paid: 80,
      pending: 500,
      shalomNumber: '123456',
      shalomCode: 'ABC123',
    })).toEqual([
      'Keyler Ortega',
      'Keyler Ortega',
      '12345678',
      'Moquegua - Ilo - Ilo Puerto',
      '1 × Guitarra Memphis · 1 × Violin clásico · 1 × capotraste · 1 × afinador',
      'S/ 580.00',
      'S/ 80.00',
      'S/ 500.00',
      '123456',
      'ABC123',
    ])
  })
})
