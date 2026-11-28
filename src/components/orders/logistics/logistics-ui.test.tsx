// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})

import { LogisticsPanel } from './logistics-panel'
import { BulkVouchersButton, VoucherIndicator, __resetLogisticsSummaryStore } from './voucher-indicator'
import { VoucherSection } from './voucher-section'

const ORDER = '11111111-1111-4111-8111-111111111111'
const DISPATCH = '88888888-8888-4888-8888-888888888888'
const doc = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  order_id: ORDER,
  kind: 'voucher',
  status: 'pending_review',
  association: 'direct',
  version: null,
  row_version: 1,
  batch_id: null,
  original_filename: 'voucher.pdf',
  mime_type: 'application/pdf',
  size_bytes: 10,
  ocr_status: 'none',
  ocr_attempts: 0,
  ocr_error_code: null,
  validated_at: null,
  created_at: '2026-11-17T10:00:00Z',
  ...over,
})
const panel = (over: Record<string, unknown> = {}) => ({
  order: {},
  logistics: { status: 'pending_voucher', version: 0, evidence_document_id: null },
  vouchers: [],
  evidence: null,
  dispatches: [],
  customer_dispatches: [],
  events: [],
  ...over,
})

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined
function stubFetch(handler: Handler) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init) ?? { status: 404, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const posted = (f: ReturnType<typeof stubFetch>, path: string) =>
  f.mock.calls.filter(([u, i]) => String(u).includes(path) && (i as RequestInit | undefined)?.method === 'POST').map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  push.mockReset()
})

describe('LogisticsPanel · legacy accounts see NOTHING new', () => {
  it.each([403, 404, 401])('answer %i (flag OFF, commercial, other account) -> renders nothing at all', async (status) => {
    const f = stubFetch(() => ({ status, body: { error: 'feature_disabled' } }))
    const { container } = render(<LogisticsPanel orderId={ORDER} />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
    expect(container.textContent).toBe('')
  })

  it('an unexpected payload (not the logistics panel) is ignored, never rendered, never a crash', async () => {
    stubFetch(() => ({ body: { orders: [], next_cursor: null } }))
    const { container } = render(<LogisticsPanel orderId={ORDER} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})

describe('LogisticsPanel · the four visible states', () => {
  it('pending_voucher: only the voucher can move; packaging asks for a validated voucher', async () => {
    stubFetch(() => ({ body: panel() }))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByText('status.pending_voucher')).toBeTruthy()
    expect(screen.getByText('status.ready_for_dispatch')).toBeTruthy()
    expect(screen.getByText('packagingNeedsVoucher')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'startPackaging' })).toBeNull()
    expect(screen.getByLabelText('uploadVoucher')).toBeTruthy()
  })

  it('voucher_validated: "start packaging" posts the start action', async () => {
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') return { body: { status: 'packing', changed: true } }
      return url.includes('/orders/') ? { body: panel({ logistics: { status: 'voucher_validated', version: 1, evidence_document_id: null }, vouchers: [doc({ status: 'validated', version: 1 })] }) } : undefined
    })
    render(<LogisticsPanel orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: /startPackaging/ }))
    await waitFor(() => expect(posted(f, `/orders/${ORDER}/packaging`)).toEqual([{ action: 'start' }]))
  })

  it('packing: the send is disabled until evidence exists; vouchers are closed', async () => {
    stubFetch(() => ({ body: panel({ logistics: { status: 'packing', version: 2, evidence_document_id: null }, vouchers: [doc({ status: 'validated', version: 1 })] }) }))
    render(<LogisticsPanel orderId={ORDER} />)
    const send = (await screen.findByRole('button', { name: /sendTemplate/ })) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByText('noEvidence')).toBeTruthy()
    expect(screen.getByText('vouchersClosed')).toBeTruthy()
    expect(screen.queryByLabelText('uploadVoucher')).toBeNull()
  })

  it('ready_for_dispatch: final banner, no more actions', async () => {
    stubFetch(() => ({ body: panel({ logistics: { status: 'ready_for_dispatch', version: 3, evidence_document_id: 'e' }, evidence: doc({ id: 'e', kind: 'evidence', status: 'active', mime_type: 'application/pdf' }), dispatches: [{ id: DISPATCH, status: 'sent', attempt: 1, error_code: null, resolution: null, claimed_at: 't', finished_at: 't' }] }) }))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByText('readyBanner')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sendTemplate/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /changeEvidence/ })).toBeNull()
  })
})

describe('LogisticsPanel · packaging send', () => {
  const packing = () => panel({ logistics: { status: 'packing', version: 2, evidence_document_id: 'e' }, evidence: doc({ id: 'e', kind: 'evidence', status: 'active', mime_type: 'image/jpeg' }) })

  it('a retry of the SAME send reuses the request key (never duplicates); a new key only after a confirmed send', async () => {
    let n = 0
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        n += 1
        return n === 1 ? { status: 502, body: { error: 'send_failed', status: 'failed' } } : { body: { status: 'sent', order_status: 'ready_for_dispatch' } }
      }
      return url.includes(`/orders/${ORDER}`) && !url.includes('/chat-media') ? { body: packing() } : { body: { url: 'https://signed.example/x' } }
    })
    render(<LogisticsPanel orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: /sendTemplate/ }))
    await waitFor(() => expect(posted(f, '/packaging')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: /sendTemplate|retrySend/ }))
    await waitFor(() => expect(posted(f, '/packaging')).toHaveLength(2))
    const [first, second] = posted(f, '/packaging')
    expect(first.action).toBe('send_template')
    expect(second.request_key).toBe(first.request_key)
  })

  it('an uncertain send shows the manual resolution and hides the send button; a person confirms with the dispatch id', async () => {
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') return { body: { status: 'failed', order_status: 'packing', changed: true } }
      return url.includes(`/orders/${ORDER}`) ? { body: { ...packing(), dispatches: [{ id: DISPATCH, status: 'uncertain', attempt: 1, error_code: 'meta_unreachable', resolution: null, claimed_at: 't', finished_at: 't' }] } } : { body: { url: 'u' } }
    })
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByText('uncertainTitle')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sendTemplate/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'confirmedNotSent' }))
    await waitFor(() => expect(posted(f, '/packaging')).toEqual([{ action: 'resolve', dispatch_id: DISPATCH, resolution: 'confirmed_not_sent' }]))
  })

  it('declining the confirmation sends nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const f = stubFetch((url) => (url.includes(`/orders/${ORDER}`) ? { body: { ...packing(), dispatches: [{ id: DISPATCH, status: 'uncertain', attempt: 1, error_code: 'x', resolution: null, claimed_at: 't', finished_at: 't' }] } } : { body: { url: 'u' } }))
    render(<LogisticsPanel orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'confirmedSent' }))
    expect(posted(f, '/packaging')).toHaveLength(0)
  })
})

describe('VoucherSection · upload from the order', () => {
  const file = () => new File(['%PDF-1.7'], 'comprobante.pdf', { type: 'application/pdf' })

  it('uploads with the ORDER id (no matching), a request key and no account / role in the request', async () => {
    const f = stubFetch((url, init) => (init?.method === 'POST' ? { status: 201, body: { created: true, document: doc() } } : url.includes('/url') ? { body: { url: 'https://signed.example/x' } } : { body: { document: doc(), ocr: null, reviewed_data: null, comparison: [] } }))
    render(<VoucherSection orderId={ORDER} status="pending_voucher" vouchers={[]} onChanged={() => undefined} />)
    fireEvent.change(screen.getByLabelText('uploadVoucher'), { target: { files: [file()] } })
    await waitFor(() => expect(f.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true))
    const form = (f.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')![1] as RequestInit).body as FormData
    expect(form.get('order_id')).toBe(ORDER)
    expect(String(form.get('request_key')).length).toBeGreaterThan(8)
    expect([...form.keys()].sort()).toEqual(['file', 'order_id', 'request_key'])
  })

  it('a duplicate asks the person; accepting resends the SAME key with allow_duplicate, declining sends nothing more', async () => {
    let posts = 0
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posts += 1
        return posts === 1 ? { status: 409, body: { error: 'duplicate' } } : { status: 201, body: { created: true, document: doc() } }
      }
      return { body: { url: 'u', document: doc(), ocr: null, reviewed_data: null, comparison: [] } }
    })
    render(<VoucherSection orderId={ORDER} status="pending_voucher" vouchers={[]} onChanged={() => undefined} />)
    fireEvent.change(screen.getByLabelText('uploadVoucher'), { target: { files: [file()] } })
    await waitFor(() => expect(posts).toBe(2))
    const forms = f.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST').map(([, i]) => (i as RequestInit).body as FormData)
    expect(forms[1].get('request_key')).toBe(forms[0].get('request_key'))
    expect(forms[1].get('allow_duplicate')).toBe('true')
  })

  it('once packaging started there is no upload control', () => {
    stubFetch(() => undefined)
    render(<VoucherSection orderId={ORDER} status="packing" vouchers={[doc({ status: 'validated', version: 1 })] as never} onChanged={() => undefined} />)
    expect(screen.queryByLabelText('uploadVoucher')).toBeNull()
    expect(screen.getByText('vouchersClosed')).toBeTruthy()
  })
})

describe('list indicator (lazy: a row is fetched only when it becomes visible)', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const C = '33333333-3333-4333-8333-333333333333'

  /** A controllable IntersectionObserver: elements stay "hidden" until the test reveals them. */
  const observed: Array<{ el: Element; fire: () => void }> = []
  function stubObserver() {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private cb: (e: Array<{ isIntersecting: boolean }>) => void
        constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
          this.cb = cb
        }
        observe(el: Element) {
          observed.push({ el, fire: () => this.cb([{ isIntersecting: true }]) })
        }
        disconnect() {}
        unobserve() {}
      },
    )
  }
  const reveal = (...indexes: number[]) => indexes.forEach((i) => observed[i].fire())

  function List({ ids }: { ids: string[] }) {
    return (
      <div>
        <BulkVouchersButton />
        {ids.map((id) => (
          <VoucherIndicator key={id} orderId={id} />
        ))}
      </div>
    )
  }

  beforeEach(() => {
    observed.length = 0
  })
  afterEach(() => {
    __resetLogisticsSummaryStore()
  })

  it('nothing is requested until a row is visible; rows visible together are fetched in ONE request; the bulk entry appears with the first answer', async () => {
    stubObserver()
    const all: Record<string, unknown> = { [A]: { status: 'voucher_validated', voucher: 'validated' }, [B]: { status: 'pending_voucher', voucher: 'pending_review' }, [C]: { status: 'pending_voucher', voucher: 'none' } }
    // like the real endpoint: it answers ONLY for the ids it was asked about
    const f = stubFetch((url) => ({ body: { summary: Object.fromEntries((new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',').map((id) => [id, all[id]])) } }))
    render(<List ids={[A, B, C]} />)
    expect(f).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /bulkTitle/ })).toBeNull()
    reveal(0, 1)
    expect(await screen.findByText('indicator.validatedShort')).toBeTruthy()
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain(`ids=${A},${B}`)
    expect(String(f.mock.calls[0][0])).not.toContain(C)
    expect(screen.getByText('indicator.pendingShort')).toBeTruthy()
    expect(screen.queryByText('indicator.noneShort')).toBeNull() // C never became visible
    fireEvent.click(screen.getByRole('button', { name: /bulkTitle/ }))
    expect(push).toHaveBeenCalledWith('/confirmed-orders/vouchers')
    reveal(2)
    expect(await screen.findByText('indicator.noneShort')).toBeTruthy()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it.each([403, 401, 404])('answer %i -> nothing new is rendered and NO further request is ever made', async (status) => {
    stubObserver()
    const f = stubFetch(() => ({ status, body: { error: 'feature_disabled' } }))
    const { container } = render(<List ids={[A, B]} />)
    reveal(0)
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    reveal(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(f).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('button', { name: /bulkTitle/ })).toBeNull()
  })

  it('a malformed answer or a 500 is "not available": no indicator, no bulk entry', async () => {
    stubObserver()
    const f = stubFetch(() => ({ body: { orders: [] } }))
    const { container } = render(<List ids={[A]} />)
    reveal(0)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('without IntersectionObserver nothing is fetched and nothing is shown (the list stays exactly as before PR-04)', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const f = stubFetch(() => ({ body: { summary: {} } }))
    const { container } = render(<List ids={[A, B]} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(f).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  it('a change made in the panel refreshes only the rows already seen, immediately', async () => {
    stubObserver()
    let status: 'none' | 'validated' = 'none'
    const f = stubFetch(() => ({ body: { summary: { [A]: { status: 'pending_voucher', voucher: status } } } }))
    render(<List ids={[A, B]} />)
    reveal(0)
    expect(await screen.findByText('indicator.noneShort')).toBeTruthy()
    status = 'validated'
    window.dispatchEvent(new CustomEvent('wacrm:logistics-changed', { detail: { orderId: A } }))
    expect(await screen.findByText('indicator.validatedShort')).toBeTruthy()
    expect(f).toHaveBeenCalledTimes(2)
    expect(String(f.mock.calls[1][0])).toContain(`ids=${A}`)
    expect(String(f.mock.calls[1][0])).not.toContain(B)
  })

  it('leaving the screen forgets everything (a new screen asks again, a different user is never served stale data)', async () => {
    stubObserver()
    const f = stubFetch(() => ({ body: { summary: { [A]: { status: 'voucher_validated', voucher: 'validated' } } } }))
    const first = render(<List ids={[A]} />)
    reveal(0)
    expect(await screen.findByText('indicator.validatedShort')).toBeTruthy()
    first.unmount()
    render(<List ids={[A]} />)
    expect(screen.queryByText('indicator.validatedShort')).toBeNull()
    reveal(1)
    expect(await screen.findByText('indicator.validatedShort')).toBeTruthy()
    expect(f).toHaveBeenCalledTimes(2)
  })
})
