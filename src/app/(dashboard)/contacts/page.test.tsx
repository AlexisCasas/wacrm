// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'

import ContactsPage from './page'

// A STABLE t (like next-intl's): the page lists it as a dependency of fetchContacts, a new function per render would loop forever.
vi.mock('next-intl', () => {
  const t = (key: string, p?: Record<string, unknown>) => (p && 'count' in p ? `${key}:${p.count}` : key)
  return { useTranslations: () => t }
})
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/date-locale', () => ({ useIntlLocaleTag: () => 'en-US' }))
vi.mock('@/components/contacts/contact-phone-line', () => ({ ContactPhoneLine: () => null }))
vi.mock('@/components/contacts/contact-form', () => ({ ContactForm: () => null }))
vi.mock('@/components/contacts/contact-detail-view', () => ({ ContactDetailView: () => null }))
vi.mock('@/components/contacts/import-modal', () => ({ ImportModal: () => null }))
vi.mock('@/components/contacts/custom-fields-manager', () => ({ CustomFieldsManager: () => null }))
vi.mock('@/hooks/use-can', () => ({ useCan: () => true }))

type Call = { table?: string; ops: Array<[string, ...unknown[]]> }
const h = vi.hoisted(() => ({
  total: 3,
  rows: [] as Array<Record<string, unknown>>,
  idRows: null as Array<Record<string, unknown>> | null,
  queries: [] as Array<{ ops: Array<[string, ...unknown[]]> }>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  tags: [{ id: 't1', name: 'Cliente', color: '#00aa00' }],
}))

vi.mock('@/lib/supabase/client', () => {
  // ONE client for the whole file: the page calls createClient() on every render and lists it as a hook dependency (like the real browser singleton).
  const client = {
      from: (table: string) => {
        const call: Call = { table, ops: [] }
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'order', 'range', 'or', 'gte', 'lt', 'in', 'eq']) b[m] = (...a: unknown[]) => { call.ops.push([m, ...a]); return b }
        b.then = (res: (v: unknown) => unknown) => {
          if (table === 'tags') return Promise.resolve({ data: h.tags }).then(res)
          if (table === 'contact_tags') return Promise.resolve({ data: [] }).then(res)
          h.queries.push(call)
          const isIdOnly = call.ops.some(([name, columns]) => name === 'select' && columns === 'id')
          const range = call.ops.find(([name]) => name === 'range')
          const rows = isIdOnly && h.idRows ? h.idRows.slice(Number(range?.[1] ?? 0), Number(range?.[2] ?? h.idRows.length - 1) + 1) : h.rows
          return Promise.resolve({ data: rows, count: h.total, error: null }).then(res)
        }
        return b
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        h.rpcs.push({ name, args })
        return Promise.resolve({ data: h.rows.map((c) => ({ contact: c, total_count: h.total })), error: null })
      },
  }
  return { createClient: () => client }
})

const fetchMock = vi.fn()
const mkRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: `Contacto ${i + 1}`, phone: `5190000000${i}`, email: null, company: null, created_at: '2026-10-01T00:00:00Z', account_id: 'a' }))
const last = () => h.queries[h.queries.length - 1]
const opsOf = (q: { ops: Array<[string, ...unknown[]]> }, name: string) => q.ops.filter((o) => o[0] === name)

beforeEach(() => {
  h.rows = mkRows(3); h.idRows = null; h.total = 3; h.queries = []; h.rpcs = []
  fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deleted: 2, conversations_deleted: 2, messages_deleted: 5 }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The first load runs twice (tags arrive -> fetchContacts is re-created -> it refetches) and each fetch drops the selection: wait for both.
async function loaded() { await screen.findByText('Contacto 1'); await waitFor(() => { expect(h.queries.length).toBeGreaterThanOrEqual(2); expect(screen.queryByText('loading')).toBeNull() }) }
// rows visible AND the fetch finished (a fetch drops the selection when it starts, so ticking during it would be lost)
async function settled() { await waitFor(() => { expect(screen.queryByText('loading')).toBeNull(); expect(screen.getByText('Contacto 1')).toBeTruthy() }) }
const pickTime = async (label: string) => {
  // the popover stays open between picks: open it only when it is closed
  if (!screen.queryByRole('radiogroup', { hidden: true })) fireEvent.click(screen.getAllByText('filterByTime')[0])
  fireEvent.click(await screen.findByRole('radio', { name: label, hidden: true }))
}
// hidden: true — a base-ui Popover/Dialog marks the rest of the page aria-hidden while it is open
// findBy: base-ui renders the checkbox semantics one tick after the row text
const rowBox = (n: number) => screen.findByRole('checkbox', { name: `Select Contacto ${n}`, hidden: true })

describe('Contacts page — time filter (server-side, created_at)', () => {
  it('no time filter: the list query has no created_at window (existing behaviour)', async () => {
    render(<ContactsPage />); await loaded()
    expect(opsOf(last(), 'gte')).toHaveLength(0); expect(opsOf(last(), 'lt')).toHaveLength(0)
    expect(opsOf(last(), 'order')).toEqual([['order', 'created_at', { ascending: false }]])
  })

  it.each([['timeToday', 'gte'], ['timeLast7', 'gte'], ['timeLast30', 'gte'], ['timeLast60', 'gte'], ['timeLast90', 'gte'], ['timeOlder30', 'lt'], ['timeOlder60', 'lt'], ['timeOlder90', 'lt']])('%s filters created_at with .%s only', async (label, op) => {
    render(<ContactsPage />); await loaded()
    await pickTime(label)
    await waitFor(() => expect(opsOf(last(), op).length).toBe(1))
    expect(opsOf(last(), op)[0][1]).toBe('created_at')
    expect(opsOf(last(), op === 'gte' ? 'lt' : 'gte')).toHaveLength(0)
    expect(JSON.stringify(last().ops)).not.toContain('updated_at'); expect(JSON.stringify(last().ops)).not.toContain('last_message_at')
  })

  it('custom range applies Desde and Hasta (inclusive) and an inverted range is not applied', async () => {
    render(<ContactsPage />); await loaded()
    await pickTime('timeCustom')
    const from = await screen.findByLabelText('timeFrom'); const to = screen.getByLabelText('timeTo')
    fireEvent.change(from, { target: { value: '2026-10-01' } })
    fireEvent.change(to, { target: { value: '2026-10-31' } })
    await waitFor(() => { expect(opsOf(last(), 'gte')).toHaveLength(1); expect(opsOf(last(), 'lt')).toHaveLength(1) })
    expect(opsOf(last(), 'gte')[0][2]).toBe(new Date(2026, 9, 1).toISOString())
    expect(opsOf(last(), 'lt')[0][2]).toBe(new Date(2026, 10, 1).toISOString())
    const before = h.queries.length
    fireEvent.change(to, { target: { value: '2026-09-01' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(h.queries.length).toBe(before)
  })

  it('search + time: both reach the same query', async () => {
    render(<ContactsPage />); await loaded()
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), { target: { value: 'Juan' } })
    await pickTime('timeOlder90')
    await waitFor(() => expect(opsOf(last(), 'lt')).toHaveLength(1))
    expect(String(opsOf(last(), 'or')[0][1])).toContain('%Juan%')
  })

  it('tags + time uses the time-aware RPC; tags alone keep calling the original RPC unchanged', async () => {
    render(<ContactsPage />); await loaded()
    fireEvent.click(screen.getAllByText('filterByTags')[0])
    fireEvent.click(await screen.findByLabelText('Filter by Cliente'))
    await waitFor(() => expect(h.rpcs.length).toBeGreaterThan(0))
    expect(h.rpcs[h.rpcs.length - 1].name).toBe('filter_contacts_by_tags')
    expect(h.rpcs[h.rpcs.length - 1].args).not.toHaveProperty('p_created_from')
    await pickTime('timeOlder90')
    await waitFor(() => expect(h.rpcs[h.rpcs.length - 1].name).toBe('filter_contacts_by_tags_time'))
    const args = h.rpcs[h.rpcs.length - 1].args
    expect(args).toMatchObject({ p_tag_ids: ['t1'], p_created_from: null })
    expect(typeof args.p_created_to).toBe('string')
  })

  it('search + tags + time reach the RPC together', async () => {
    render(<ContactsPage />); await loaded()
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), { target: { value: 'Juan' } })
    fireEvent.click(screen.getAllByText('filterByTags')[0])
    fireEvent.click(await screen.findByLabelText('Filter by Cliente'))
    await pickTime('timeLast30')
    await waitFor(() => expect(h.rpcs[h.rpcs.length - 1].name).toBe('filter_contacts_by_tags_time'))
    expect(h.rpcs[h.rpcs.length - 1].args).toMatchObject({ p_tag_ids: ['t1'], p_search: 'Juan', p_offset: 0, p_limit: 25 })
  })

  it('"Todos" removes the window again', async () => {
    render(<ContactsPage />); await loaded()
    await pickTime('timeLast30'); await waitFor(() => expect(opsOf(last(), 'gte')).toHaveLength(1))
    await pickTime('timeAll'); await waitFor(() => expect(opsOf(last(), 'gte')).toHaveLength(0))
  })

  it('a time filter does not select anything', async () => {
    render(<ContactsPage />); await loaded()
    await pickTime('timeOlder90')
    await waitFor(() => expect(opsOf(last(), 'lt')).toHaveLength(1))
    expect(screen.queryByText(/^selectedCount/)).toBeNull()
  })
})

describe('Contacts page — selection', () => {
  it('0 selected: no bulk bar; 1 selected: bar with count; N selected: only the ticked rows', async () => {
    render(<ContactsPage />); await loaded()
    expect(screen.queryByText(/^selectedCount/)).toBeNull()
    fireEvent.click(await rowBox(1)); expect(screen.getByText('selectedCount:1')).toBeTruthy()
    fireEvent.click(await rowBox(3)); expect(screen.getByText('selectedCount:2')).toBeTruthy()
    expect((await rowBox(2)).getAttribute('aria-checked')).toBe('false')
  })

  it('select all represents the complete current result set, not only the visible page', async () => {
    h.rows = mkRows(3); h.total = 60
    render(<ContactsPage />); await loaded()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'selectAllAria', hidden: true }))
    expect(screen.getByText('selectedCount:60')).toBeTruthy()
  })

  it('changing page keeps a global selection; changing search, tag or time clears it', async () => {
    h.total = 60
    render(<ContactsPage />); await settled()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'selectAllAria', hidden: true }))
    expect(screen.getByText('selectedCount:60')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('svg.lucide-chevron-right'))!)
    await settled(); expect(screen.getByText('selectedCount:60')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), { target: { value: 'x' } })
    await waitFor(() => expect(screen.queryByText(/^selectedCount/)).toBeNull()); await settled()
    fireEvent.click(await rowBox(1)); fireEvent.click(screen.getAllByText('filterByTags')[0]); fireEvent.click(await screen.findByLabelText('Filter by Cliente'))
    await waitFor(() => expect(screen.queryByText(/^selectedCount/)).toBeNull()); await settled()
    fireEvent.click(await rowBox(1)); await pickTime('timeLast7')
    await waitFor(() => expect(screen.queryByText(/^selectedCount/)).toBeNull())
  })

  it('Clear removes the whole global selection', async () => {
    h.total = 60
    render(<ContactsPage />); await loaded()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'selectAllAria', hidden: true }))
    fireEvent.click(screen.getByText('clearSelection'))
    expect(screen.queryByText(/^selectedCount/)).toBeNull()
  })
})

describe('Contacts page — delete', () => {
  async function selectTwoAndOpenDialog() {
    render(<ContactsPage />); await loaded()
    fireEvent.click(await rowBox(1)); fireEvent.click(await rowBox(3))
    fireEvent.click(screen.getByText('deleteSelected'))
    return await screen.findByRole('dialog')
  }

  it('the modal states the count, the chats/messages scope and that it cannot be undone', async () => {
    const dialog = await selectTwoAndOpenDialog()
    expect(within(dialog).getByText('deleteBulkTitle:2')).toBeTruthy()
    expect(within(dialog).getByText(/deleteBulkDesc:2/)).toBeTruthy()
    expect(within(dialog).getByText(/deleteBulkRecreate/)).toBeTruthy() // a contact that writes again is created as a NEW contact
    expect(within(dialog).getByText('deleteBulkIrreversible')).toBeTruthy()
    expect(within(dialog).getByText('deleteBulkConfirm:2')).toBeTruthy()
  })

  it('sends ONLY the selected ids (no filters, search, tag or time) and refreshes the list', async () => {
    render(<ContactsPage />); await loaded()
    await pickTime('timeOlder90')
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), { target: { value: 'Juan' } })
    await waitFor(() => expect(screen.getByText('Contacto 1')).toBeTruthy())
    fireEvent.click(await rowBox(1)); fireEvent.click(await rowBox(3))
    fireEvent.click(screen.getByText('deleteSelected'))
    fireEvent.click(await screen.findByText('deleteBulkConfirm:2'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/contacts/bulk-delete')
    expect(JSON.parse(init.body)).toEqual({ contact_ids: ['c1', 'c3'] })
    await waitFor(() => expect(screen.queryByText(/^selectedCount/)).toBeNull())
  })

  it('double submit is protected: the confirm button is disabled and only one request goes out', async () => {
    let release!: (v: unknown) => void
    fetchMock.mockReturnValue(new Promise((r) => { release = r }))
    await selectTwoAndOpenDialog()
    const confirm = screen.getByText('deleteBulkConfirm:2').closest('button') as HTMLButtonElement
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(confirm.disabled).toBe(true)
    release({ ok: true, json: async () => ({ deleted: 2 }) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('deletes a global selection over 100 ids sequentially in batches of at most 100', async () => {
    h.idRows = mkRows(101); h.total = 101
    render(<ContactsPage />); await loaded()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'selectAllAria', hidden: true }))
    fireEvent.click(screen.getByText('deleteSelected'))
    fireEvent.click(await screen.findByText('deleteBulkConfirm:101'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    for (const [, init] of fetchMock.mock.calls) expect(JSON.parse(init.body).contact_ids.length).toBeLessThanOrEqual(100)
  })

  it('does not report a full success when a later batch fails and keeps the pending ids selected', async () => {
    const { toast } = await import('sonner')
    h.idRows = mkRows(101); h.total = 101
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 100 }) }).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'nope' }) })
    render(<ContactsPage />); await loaded()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'selectAllAria', hidden: true }))
    fireEvent.click(screen.getByText('deleteSelected'))
    fireEvent.click(await screen.findByText('deleteBulkConfirm:101'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(toast.success).not.toHaveBeenCalledWith('toastBulkDeleted:101')
    expect(screen.getByText('selectedCount:1')).toBeTruthy()
  })

  it('a failed delete keeps the selection and shows the error', async () => {
    const { toast } = await import('sonner')
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'nope', deleted: 0 }) })
    await selectTwoAndOpenDialog()
    fireEvent.click(screen.getByText('deleteBulkConfirm:2'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('toastBulkFailedDelete'))
  })

  it('single delete (three dots menu) keeps its UX and uses the same safe endpoint with one id', async () => {
    render(<ContactsPage />); await loaded()
    const row = (await screen.findByText('Contacto 2')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getAllByRole('button')[0])
    fireEvent.click(await screen.findByText('deleteAction'))
    fireEvent.click(await screen.findByText('deleteBtn'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ contact_ids: ['c2'] })
  })

  it('a clean cleanup shows the normal success; pending media cleanup is a warning (the contacts WERE deleted), never a failure', async () => {
    const { toast } = await import('sonner')
    vi.mocked(toast.success).mockClear(); vi.mocked(toast.warning).mockClear()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deleted: 2, cleanup_complete: true, storage_pending: 0 }) })
    await selectTwoAndOpenDialog()
    fireEvent.click(screen.getByText('deleteBulkConfirm:2'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('toastBulkDeleted:2'))
    expect(toast.warning).not.toHaveBeenCalled()

    cleanup(); vi.mocked(toast.success).mockClear()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deleted: 2, cleanup_complete: false, storage_pending: 3 }) })
    await selectTwoAndOpenDialog()
    fireEvent.click(screen.getByText('deleteBulkConfirm:2'))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('toastMediaCleanupIncomplete'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
