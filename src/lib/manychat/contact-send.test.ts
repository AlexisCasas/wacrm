import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendManyChatTextMock = vi.fn()
const sendManyChatFlowMock = vi.fn()
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendManyChatText: (...args: unknown[]) =>
    (sendManyChatTextMock as unknown as (...a: unknown[]) => unknown)(...args),
  sendManyChatFlow: (...args: unknown[]) =>
    (sendManyChatFlowMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

import {
  sendManyChatTextToContact,
  sendManyChatFlowToContact,
  ManyChatNotConfiguredError,
  ManyChatContactNotLinkedError,
  ManyChatMappingLookupError,
} from './contact-send'
import { ManyChatApiError } from './api'

const API_KEY = 'mc-key-test'

interface Captured {
  lookup?: { accountId: string; contactId: string }
}

function fakeDb(opts: {
  link?: { manychat_contact_id: string } | null
  linkError?: { message: string } | null
  captured: Captured
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'manychat_contact_links') {
        return {
          select: () => ({
            eq: (_col: string, accountId: string) => ({
              eq: (_col2: string, contactId: string) => ({
                maybeSingle: async () => {
                  opts.captured.lookup = { accountId, contactId }
                  return { data: opts.link ?? null, error: opts.linkError ?? null }
                },
              }),
            }),
          }),
        }
      }
      // Any other table access from this primitive would be a bug — it
      // must never touch messages/conversations/flow_runs.
      throw new Error(`unexpected table: ${table}`)
    },
  } as unknown as SupabaseClient
}

const originalApiKey = process.env.MANYCHAT_API_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MANYCHAT_API_KEY = API_KEY
  sendManyChatTextMock.mockResolvedValue({ raw: { status: 'success' } })
  sendManyChatFlowMock.mockResolvedValue({ raw: { status: 'success' } })
})

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.MANYCHAT_API_KEY
  else process.env.MANYCHAT_API_KEY = originalApiKey
})

describe('sendManyChatTextToContact — tenancy', () => {
  it('looks up the mapping scoped to BOTH account_id and contact_id', async () => {
    const captured: Captured = {}
    await sendManyChatTextToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      text: 'hi',
    })
    expect(captured.lookup).toEqual({ accountId: 'acct-1', contactId: 'contact-1' })
  })

  it("a different account's mapping is invisible — the scoped lookup returns null", async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatTextToContact({
        // Simulates account B querying with account A's contact_id: the
        // real account_id-scoped query would return no row.
        db: fakeDb({ link: null, captured }),
        accountId: 'acct-B',
        contactId: 'contact-owned-by-acct-A',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(ManyChatContactNotLinkedError)
    expect(captured.lookup).toEqual({
      accountId: 'acct-B',
      contactId: 'contact-owned-by-acct-A',
    })
  })
})

describe('sendManyChatTextToContact — guard clauses (fail before any send)', () => {
  it('throws ManyChatNotConfiguredError before any DB lookup when the API key is missing', async () => {
    delete process.env.MANYCHAT_API_KEY
    const captured: Captured = {}
    await expect(
      sendManyChatTextToContact({
        db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(ManyChatNotConfiguredError)
    expect(captured.lookup).toBeUndefined()
    expect(sendManyChatTextMock).not.toHaveBeenCalled()
  })

  it('throws ManyChatContactNotLinkedError when no mapping row exists', async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatTextToContact({
        db: fakeDb({ link: null, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(ManyChatContactNotLinkedError)
    expect(sendManyChatTextMock).not.toHaveBeenCalled()
  })

  it('throws ManyChatMappingLookupError on a genuine DB error (distinct from "no row")', async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatTextToContact({
        db: fakeDb({ linkError: { message: 'db down' }, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(ManyChatMappingLookupError)
    expect(sendManyChatTextMock).not.toHaveBeenCalled()
  })
})

describe('sendManyChatTextToContact — ManyChat failures propagate untouched', () => {
  it.each([401, 403, 429, 500, 502, 504])(
    'propagates a ManyChatApiError(%i) from sendManyChatText',
    async (status) => {
      sendManyChatTextMock.mockRejectedValue(new ManyChatApiError(status, `boom ${status}`))
      const captured: Captured = {}
      await expect(
        sendManyChatTextToContact({
          db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
          accountId: 'acct-1',
          contactId: 'contact-1',
          text: 'hi',
        }),
      ).rejects.toMatchObject({ status, message: `boom ${status}` })
    },
  )
})

describe('sendManyChatTextToContact — success', () => {
  it('passes the mapped manychat_contact_id + text through to sendManyChatText', async () => {
    await sendManyChatTextToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-999' }, captured: {} }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      text: 'Hola!',
    })
    expect(sendManyChatTextMock).toHaveBeenCalledWith({
      apiKey: API_KEY,
      manyChatContactId: 'mc-999',
      text: 'Hola!',
    })
  })

  it('returns manychat-out:<uuid> when ManyChat gives no message id', async () => {
    const result = await sendManyChatTextToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured: {} }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      text: 'hi',
    })
    expect(result.whatsappMessageId).toMatch(/^manychat-out:/)
    // Never a fabricated Meta-shaped id.
    expect(result.whatsappMessageId).not.toMatch(/^wamid\./)
  })

  it('does not touch messages/conversations/flow_runs — transport only', async () => {
    // fakeDb throws on any table other than manychat_contact_links, so
    // reaching a resolved result at all proves this.
    await expect(
      sendManyChatTextToContact({
        db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured: {} }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        text: 'hi',
      }),
    ).resolves.toBeDefined()
  })
})

// ============================================================
// sendManyChatFlowToContact — the media bridge primitive.
// ============================================================

const FLOW_NS = 'content2026abc123'

describe('sendManyChatFlowToContact — tenancy', () => {
  it('looks up the mapping scoped to BOTH account_id and contact_id (never contact_id alone)', async () => {
    const captured: Captured = {}
    await sendManyChatFlowToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      flowNs: FLOW_NS,
    })
    expect(captured.lookup).toEqual({ accountId: 'acct-1', contactId: 'contact-1' })
  })

  it("a different account's mapping is invisible — the scoped lookup returns null", async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatFlowToContact({
        db: fakeDb({ link: null, captured }),
        accountId: 'acct-B',
        contactId: 'contact-owned-by-acct-A',
        flowNs: FLOW_NS,
      }),
    ).rejects.toBeInstanceOf(ManyChatContactNotLinkedError)
    expect(captured.lookup).toEqual({
      accountId: 'acct-B',
      contactId: 'contact-owned-by-acct-A',
    })
  })
})

describe('sendManyChatFlowToContact — guard clauses (fail before any send)', () => {
  it('throws ManyChatNotConfiguredError before any DB lookup when the API key is missing', async () => {
    delete process.env.MANYCHAT_API_KEY
    const captured: Captured = {}
    await expect(
      sendManyChatFlowToContact({
        db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        flowNs: FLOW_NS,
      }),
    ).rejects.toBeInstanceOf(ManyChatNotConfiguredError)
    expect(captured.lookup).toBeUndefined()
    expect(sendManyChatFlowMock).not.toHaveBeenCalled()
  })

  it('throws ManyChatContactNotLinkedError when no mapping row exists', async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatFlowToContact({
        db: fakeDb({ link: null, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        flowNs: FLOW_NS,
      }),
    ).rejects.toBeInstanceOf(ManyChatContactNotLinkedError)
    expect(sendManyChatFlowMock).not.toHaveBeenCalled()
  })

  it('throws ManyChatMappingLookupError on a genuine DB error (distinct from "no row")', async () => {
    const captured: Captured = {}
    await expect(
      sendManyChatFlowToContact({
        db: fakeDb({ linkError: { message: 'db down' }, captured }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        flowNs: FLOW_NS,
      }),
    ).rejects.toBeInstanceOf(ManyChatMappingLookupError)
    expect(sendManyChatFlowMock).not.toHaveBeenCalled()
  })
})

describe('sendManyChatFlowToContact — ManyChat failures propagate untouched', () => {
  it.each([400, 401, 403, 429, 500, 502, 504])(
    'propagates a ManyChatApiError(%i) from sendManyChatFlow',
    async (status) => {
      sendManyChatFlowMock.mockRejectedValue(new ManyChatApiError(status, `boom ${status}`))
      const captured: Captured = {}
      await expect(
        sendManyChatFlowToContact({
          db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured }),
          accountId: 'acct-1',
          contactId: 'contact-1',
          flowNs: FLOW_NS,
        }),
      ).rejects.toMatchObject({ status, message: `boom ${status}` })
    },
  )
})

describe('sendManyChatFlowToContact — success', () => {
  it('passes the mapped manychat_contact_id + flowNs through to sendManyChatFlow', async () => {
    await sendManyChatFlowToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-999' }, captured: {} }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      flowNs: FLOW_NS,
    })
    expect(sendManyChatFlowMock).toHaveBeenCalledWith({
      apiKey: API_KEY,
      manyChatContactId: 'mc-999',
      flowNs: FLOW_NS,
    })
  })

  it('returns manychat-flow:<uuid> when ManyChat gives no message id', async () => {
    const result = await sendManyChatFlowToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured: {} }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      flowNs: FLOW_NS,
    })
    expect(result.whatsappMessageId).toMatch(/^manychat-flow:/)
    // Never a fabricated Meta-shaped id, and never the text-bridge prefix.
    expect(result.whatsappMessageId).not.toMatch(/^wamid\./)
    expect(result.whatsappMessageId).not.toMatch(/^manychat-out:/)
  })

  it('uses the returned message id when ManyChat provides one', async () => {
    sendManyChatFlowMock.mockResolvedValue({ raw: { status: 'success', message_id: 'evt-42' } })
    const result = await sendManyChatFlowToContact({
      db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured: {} }),
      accountId: 'acct-1',
      contactId: 'contact-1',
      flowNs: FLOW_NS,
    })
    expect(result.whatsappMessageId).toBe('manychat-flow:evt-42')
  })

  it('does not touch messages/conversations/flow_runs — transport only', async () => {
    // fakeDb throws on any table other than manychat_contact_links, so
    // reaching a resolved result at all proves this.
    await expect(
      sendManyChatFlowToContact({
        db: fakeDb({ link: { manychat_contact_id: 'mc-1' }, captured: {} }),
        accountId: 'acct-1',
        contactId: 'contact-1',
        flowNs: FLOW_NS,
      }),
    ).resolves.toBeDefined()
  })
})
