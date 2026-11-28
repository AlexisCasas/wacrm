// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})

import { CustomerTemplateActions } from './customer-template-actions'

const ORDER = '11111111-1111-4111-8111-111111111111'
const VOUCHER = '33333333-3333-4333-8333-333333333333'
const DISPATCH = '77777777-7777-4777-8777-777777777777'

const voucher = {
  id: VOUCHER,
  order_id: ORDER,
  kind: 'voucher' as const,
  status: 'validated' as const,
  association: 'direct' as const,
  version: 1,
  row_version: 1,
  batch_id: null,
  original_filename: 'voucher.pdf',
  mime_type: 'application/pdf',
  size_bytes: 100,
  ocr_status: 'done' as const,
  ocr_attempts: 1,
  ocr_error_code: null,
  validated_at: '2026-11-28T12:00:00.000Z',
  created_at: '2026-11-28T12:00:00.000Z',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-28T12:09:30.000Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CustomerTemplateActions stale in-flight recovery', () => {
  it('reenables a stuck send after 10 minutes without a panel reload', async () => {
    render(
      <CustomerTemplateActions
        orderId={ORDER}
        voucherDocumentId={VOUCHER}
        vouchers={[voucher]}
        dispatches={[{
          id: DISPATCH,
          kind: 'summary',
          status: 'sending',
          attempt: 1,
          error_code: null,
          resolution: null,
          voucher_document_id: VOUCHER,
          claimed_at: '2026-11-28T12:00:00.000Z',
          sending_at: '2026-11-28T12:00:00.000Z',
          created_at: '2026-11-28T12:00:00.000Z',
        }]}
        onChanged={() => undefined}
      />,
    )

    const summary = screen.getByRole('button', { name: 'customerSendSummary' }) as HTMLButtonElement
    expect(summary.disabled).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    expect(summary.disabled).toBe(false)
  })
})
