import { createVisionOcrProvider, VISION_PROVIDER_NAME } from '@/lib/orders/logistics/ocr/vision-provider'
import { VoucherOcrError, type VoucherOcrInput, type VoucherOcrOutput, type VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

// Provider registry. NO real provider exists yet and none is chosen: this file only offers the two local ones.
//   not_configured  default everywhere. Always fails with `ocr_not_configured`, which the UI turns into MANUAL CAPTURE of the voucher data
//                   (the review / validation flow works without any provider).
//   fake            deterministic stand-in for local development and tests. It is NEVER selectable in production.

export const notConfiguredProvider: VoucherOcrProvider = {
  name: 'not_configured',
  async extract(): Promise<VoucherOcrOutput> {
    throw new VoucherOcrError('ocr_not_configured')
  },
}

export interface FakeProviderScript {
  /** Fields to return (defaults to a plausible voucher). */
  fields?: VoucherOcrOutput['fields']
  /** Fail with this typed code instead of returning fields. */
  fail?: 'ocr_provider_error' | 'ocr_rate_limited' | 'ocr_unreadable' | 'ocr_invalid_response'
  /** Never answer until aborted (simulates a hung provider -> timeout). */
  hang?: boolean
}

export const DEFAULT_FAKE_FIELDS: VoucherOcrOutput['fields'] = {
  dni: { value: '12345678', confidence: 0.95 },
  phone: { value: '51900000001', confidence: 0.9 },
  customer_name: { value: 'Cliente Prueba', confidence: 0.8 },
  amount: { value: '10.00', confidence: 0.85 },
}

export function createFakeProvider(script: FakeProviderScript = {}): VoucherOcrProvider {
  return {
    name: 'fake',
    async extract(input: VoucherOcrInput): Promise<VoucherOcrOutput> {
      if (script.hang) {
        await new Promise<never>((_, reject) => input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      if (script.fail) throw new VoucherOcrError(script.fail)
      return { provider: 'fake', model: 'fake-1', fields: script.fields ?? DEFAULT_FAKE_FIELDS }
    },
  }
}

/**
 * The provider for this process. Today: `not_configured`, or the fake one when ORDER_OCR_PROVIDER=fake outside production. A real provider will be
 * registered here (and nowhere else) when it is chosen with real samples; until then production can only ever resolve `not_configured`.
 */
export function resolveOcrProvider(env: Record<string, string | undefined> = process.env): VoucherOcrProvider {
  if (env.ORDER_OCR_PROVIDER === 'fake' && env.NODE_ENV !== 'production') return createFakeProvider()
  // The real provider needs the three variables; a missing one resolves not_configured (never throws), so a half-set environment cannot call out.
  if (env.ORDER_OCR_PROVIDER === VISION_PROVIDER_NAME && env.ORDER_OCR_API_KEY && env.ORDER_OCR_MODEL) {
    return createVisionOcrProvider({ apiKey: env.ORDER_OCR_API_KEY, model: env.ORDER_OCR_MODEL, baseUrl: env.ORDER_OCR_BASE_URL || undefined })
  }
  // The real provider needs all three variables; a missing one resolves not_configured (never throws), so a half-set environment cannot call out.
  if (env.ORDER_OCR_PROVIDER === VISION_PROVIDER_NAME && env.ORDER_OCR_API_KEY && env.ORDER_OCR_MODEL) {
    return createVisionOcrProvider({ apiKey: env.ORDER_OCR_API_KEY, model: env.ORDER_OCR_MODEL, baseUrl: env.ORDER_OCR_BASE_URL || undefined })
  }
  return notConfiguredProvider
}
