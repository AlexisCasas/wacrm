// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})

import { LogisticsPanel } from './logistics-panel'

// PR-04 · packaging evidence UPLOADED from the device: the primary action of the Embalaje section; the chat is an optional alternative.

const ORDER = '11111111-1111-4111-8111-111111111111'
const doc = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333', order_id: ORDER, kind: 'voucher', status: 'validated', association: 'direct', version: 1, row_version: 2, batch_id: null,
  original_filename: 'voucher.pdf', mime_type: 'application/pdf', size_bytes: 10, ocr_status: 'done', ocr_attempts: 1, ocr_error_code: null, validated_at: 't', created_at: 't', ...over,
})
const evidence = doc({ id: 'e-1', kind: 'evidence', status: 'active', original_filename: 'embalaje.jpg', mime_type: 'image/jpeg', version: null })
const packing = (ev: unknown = null) => ({ order: {}, logistics: { status: 'packing', version: 2, evidence_document_id: ev ? 'e-1' : null }, vouchers: [doc()], evidence: ev, dispatches: [], customer_dispatches: [], events: [] })
const chat = (available: boolean[]) => ({ media: available.map((a, i) => ({ message_id: `m-${i}`, content_type: 'image', created_at: 't', available: a, preview_url: a ? 'https://x/y.jpg' : null })) })

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined
function stubFetch(handler: Handler) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init) ?? { status: 404, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const posts = (f: ReturnType<typeof stubFetch>, path: string) => f.mock.calls.filter(([u, i]) => String(u).includes(path) && (i as RequestInit | undefined)?.method === 'POST')
const file = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'embalaje.jpg', { type: 'image/jpeg' })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Embalaje · upload the packaging evidence from the device', () => {
  it('works with a chat that has NO files: the upload control is there, the chat button is not', async () => {
    const f = stubFetch((url) => (url.includes('/chat-media') ? { body: chat([]) } : url.includes(`/orders/${ORDER}`) ? { body: packing() } : undefined))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByLabelText('uploadEvidence')).toBeTruthy()
    expect(screen.getByRole('button', { name: /uploadEvidence/ })).toBeTruthy()
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/chat-media'))).toBe(true))
    expect(screen.queryByRole('button', { name: /pickFromChat/ })).toBeNull()
    expect((screen.getByRole('button', { name: /sendTemplate/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the chat alternative appears only when the conversation has at least one reusable file', async () => {
    stubFetch((url) => (url.includes('/chat-media') ? { body: chat([false, true]) } : url.includes(`/orders/${ORDER}`) ? { body: packing() } : undefined))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByRole('button', { name: /pickFromChat/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /uploadEvidence/ })).toBeTruthy()
  })

  it('uploads to the ORDER evidence endpoint with a request key, only file + request_key (no account / role / actor), and refreshes the panel', async () => {
    let uploaded = false
    const f = stubFetch((url, init) => {
      if (url.includes('/evidence/upload') && init?.method === 'POST') {
        uploaded = true
        return { status: 201, body: { created: true, evidence } }
      }
      if (url.includes('/chat-media')) return { body: chat([]) }
      if (url.includes('/url')) return { body: { url: 'https://signed.example/x.jpg' } }
      return url.includes(`/orders/${ORDER}`) ? { body: packing(uploaded ? evidence : null) } : undefined
    })
    render(<LogisticsPanel orderId={ORDER} />)
    fireEvent.change(await screen.findByLabelText('uploadEvidence'), { target: { files: [file()] } })
    await waitFor(() => expect(posts(f, `/orders/${ORDER}/evidence/upload`)).toHaveLength(1))
    const form = (posts(f, '/evidence/upload')[0][1] as RequestInit).body as FormData
    expect([...form.keys()].sort()).toEqual(['file', 'request_key'])
    expect(String(form.get('request_key')).length).toBeGreaterThan(8)
    // the panel reloads: the evidence is shown and the template send is now enabled
    expect(await screen.findByText('embalaje.jpg')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: /sendTemplate/ }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('button', { name: /replaceEvidence/ })).toBeTruthy()
  })

  it('a retry of the same file reuses the request key (never a second evidence)', async () => {
    let n = 0
    const f = stubFetch((url, init) => {
      if (url.includes('/evidence/upload') && init?.method === 'POST') return (n += 1) === 1 ? { status: 502, body: { error: 'storage_failed' } } : { status: 200, body: { created: false, evidence } }
      if (url.includes('/chat-media')) return { body: chat([]) }
      return url.includes(`/orders/${ORDER}`) ? { body: packing() } : undefined
    })
    render(<LogisticsPanel orderId={ORDER} />)
    const input = await screen.findByLabelText('uploadEvidence')
    const same = file()
    fireEvent.change(input, { target: { files: [same] } })
    await waitFor(() => expect(n).toBe(1))
    fireEvent.change(input, { target: { files: [same] } })
    await waitFor(() => expect(n).toBe(2))
    const keys = posts(f, '/evidence/upload').map(([, i]) => ((i as RequestInit).body as FormData).get('request_key'))
    expect(keys[1]).toBe(keys[0])
  })

  it('no upload control once the order is ready for dispatch, nor while an uncertain send is open', async () => {
    stubFetch((url) => (url.includes('/chat-media') ? { body: chat([]) } : url.includes('/url') ? { body: { url: 'u' } } : url.includes(`/orders/${ORDER}`) ? { body: { ...packing(evidence), logistics: { status: 'ready_for_dispatch', version: 3, evidence_document_id: 'e-1' } } } : undefined))
    const { unmount } = render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByText('readyBanner')).toBeTruthy()
    expect(screen.queryByLabelText('uploadEvidence')).toBeNull()
    unmount()
    stubFetch((url) => (url.includes('/chat-media') ? { body: chat([]) } : url.includes('/url') ? { body: { url: 'u' } } : url.includes(`/orders/${ORDER}`) ? { body: { ...packing(evidence), dispatches: [{ id: 'd1', status: 'uncertain', attempt: 1, error_code: null, resolution: null, claimed_at: 't', finished_at: null }] } } : undefined))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByText('uncertainTitle')).toBeTruthy()
    expect(screen.queryByLabelText('uploadEvidence')).toBeNull()
  })

  it('voucher_validated shows no evidence upload yet (packaging has to start first)', async () => {
    stubFetch((url) => (url.includes(`/orders/${ORDER}`) ? { body: { ...packing(), logistics: { status: 'voucher_validated', version: 1, evidence_document_id: null } } } : undefined))
    render(<LogisticsPanel orderId={ORDER} />)
    expect(await screen.findByRole('button', { name: /startPackaging/ })).toBeTruthy()
    expect(screen.queryByLabelText('uploadEvidence')).toBeNull()
  })
})
