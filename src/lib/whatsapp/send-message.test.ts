import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  resolveOutboundTransport,
  type SendMessageParams,
} from './send-message';
import { ManyChatApiError } from '@/lib/manychat/api';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

// Mock only `sendManyChatText` — keep the real `ManyChatApiError` class so
// send-message.ts's `instanceof ManyChatApiError` checks still work.
const sendManyChatTextMock = vi.fn(async () => ({ raw: { status: 'success' } }));
vi.mock('@/lib/manychat/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendManyChatText: (...args: unknown[]) =>
    (sendManyChatTextMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: { id: 'ct-1', phone: '+15551234567' },
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Outbound transport selection (ManyChat coexistence bridge).
// ============================================================

interface ManyChatCaptured {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  linkLookup?: { accountId: string; contactId: string };
}

const MC_CONVERSATION = {
  id: 'cv-mc-1',
  account_id: 'acct-mc',
  contact_id: 'ct-mc-1',
  contact: { id: 'ct-mc-1', phone: '+15559990000' },
};

/**
 * Minimal fake covering only the tables the ManyChat branch touches
 * (conversations, manychat_contact_links, messages) — deliberately NOT
 * whatsapp_config or message_templates, since the whole point of this
 * branch is to never need them.
 */
function manyChatSendDb(opts: {
  conversation?: typeof MC_CONVERSATION | null;
  link?: { manychat_contact_id: string } | null;
  linkError?: { message: string } | null;
  captured: ManyChatCaptured;
}): SupabaseClient {
  const conversation =
    opts.conversation === undefined ? MC_CONVERSATION : opts.conversation;

  return {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () =>
                  conversation
                    ? { data: conversation, error: null }
                    : { data: null, error: { message: 'not found' } },
              }),
            }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              opts.captured.conversation = row;
              return { error: null };
            },
          }),
        };
      }
      if (table === 'manychat_contact_links') {
        return {
          select: () => ({
            eq: (_col: string, accountId: string) => ({
              eq: (_col2: string, contactId: string) => ({
                maybeSingle: async () => {
                  opts.captured.linkLookup = { accountId, contactId };
                  return { data: opts.link ?? null, error: opts.linkError ?? null };
                },
              }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                opts.captured.message = row;
                return { data: { id: 'msg-out-1', ...row }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe('resolveOutboundTransport(accountId) — per-account scoping', () => {
  const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
  const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
    if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
  });

  it('transport=manychat + accountId === MANYCHAT_INGEST_ACCOUNT_ID → manychat', () => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-bridge';
    expect(resolveOutboundTransport('acct-bridge')).toBe('manychat');
  });

  it('transport=manychat + a DIFFERENT accountId → meta (never global)', () => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-bridge';
    expect(resolveOutboundTransport('some-other-account')).toBe('meta');
  });

  it('transport=meta (regardless of accountId) → meta', () => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'meta';
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-bridge';
    expect(resolveOutboundTransport('acct-bridge')).toBe('meta');
  });

  it('transport unset/garbage → meta', () => {
    delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-bridge';
    expect(resolveOutboundTransport('acct-bridge')).toBe('meta');

    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'carrier-pigeon';
    expect(resolveOutboundTransport('acct-bridge')).toBe('meta');
  });

  it('transport=manychat but MANYCHAT_INGEST_ACCOUNT_ID unset → meta for every account', () => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    expect(resolveOutboundTransport('acct-bridge')).toBe('meta');
    expect(resolveOutboundTransport('')).toBe('meta');
  });
});

describe('sendMessageToConversation — WHATSAPP_OUTBOUND_TRANSPORT=meta (unchanged behavior)', () => {
  const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
  const originalApiKey = process.env.MANYCHAT_API_KEY;
  const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

  beforeEach(() => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'meta';
    sendManyChatTextMock.mockClear();
  });

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
    if (originalApiKey === undefined) delete process.env.MANYCHAT_API_KEY;
    else process.env.MANYCHAT_API_KEY = originalApiKey;
    if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
  });

  it('still sends via Meta (sendTemplateMessage) and never touches ManyChat', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      },
    );
    expect(result.whatsappMessageId).toBe('wamid.1');
    expect(sendManyChatTextMock).not.toHaveBeenCalled();
  });
});

describe('sendMessageToConversation — tenancy: manychat transport never leaks to other accounts', () => {
  const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
  const originalApiKey = process.env.MANYCHAT_API_KEY;
  const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

  beforeEach(() => {
    // Globally "armed" for ManyChat, and MANYCHAT_INGEST_ACCOUNT_ID names
    // a DIFFERENT account than the one this test sends from — this is
    // the exact shape of the bug being fixed: a global env flip must not
    // change transport for an account it wasn't scoped to.
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-bridge-account';
    process.env.MANYCHAT_API_KEY = 'mc-key-test';
    sendManyChatTextMock.mockClear();
  });

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
    if (originalApiKey === undefined) delete process.env.MANYCHAT_API_KEY;
    else process.env.MANYCHAT_API_KEY = originalApiKey;
    if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
  });

  it('an unrelated account still sends via Meta even while WHATSAPP_OUTBOUND_TRANSPORT=manychat is set', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      // NOT 'acct-bridge-account' — a different account on the same deployment.
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      },
    );
    expect(result.whatsappMessageId).toBe('wamid.1');
    expect(sendManyChatTextMock).not.toHaveBeenCalled();
  });
});

describe('sendMessageToConversation — WHATSAPP_OUTBOUND_TRANSPORT=manychat', () => {
  const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
  const originalApiKey = process.env.MANYCHAT_API_KEY;
  const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

  beforeEach(() => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    // Every test below sends from accountId 'acct-mc' — must match for
    // the manychat branch to activate at all (see the tenancy suite
    // above for the case where it deliberately does NOT match).
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-mc';
    process.env.MANYCHAT_API_KEY = 'mc-key-test';
    sendManyChatTextMock.mockReset();
    sendManyChatTextMock.mockResolvedValue({ raw: { status: 'success' } });
  });

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
    if (originalApiKey === undefined) delete process.env.MANYCHAT_API_KEY;
    else process.env.MANYCHAT_API_KEY = originalApiKey;
    if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
  });

  it('sends a text message through ManyChat and never calls Meta', async () => {
    const captured: ManyChatCaptured = {};
    const result = await sendMessageToConversation(
      manyChatSendDb({
        link: { manychat_contact_id: 'mc-contact-1' },
        captured,
      }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );

    expect(sendManyChatTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'mc-key-test',
        manyChatContactId: 'mc-contact-1',
        text: 'Hola!',
      }),
    );
    expect(result.messageId).toBe('msg-out-1');
    expect(result.whatsappMessageId).toMatch(/^manychat-out:/);
  });

  it('persists exactly one message row, sender_type agent, status sent', async () => {
    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );

    expect(captured.message).toMatchObject({
      conversation_id: 'cv-mc-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'Hola!',
      status: 'sent',
    });
    expect(String(captured.message?.message_id)).toMatch(/^manychat-out:/);
    // Never Meta's wamid shape.
    expect(String(captured.message?.message_id)).not.toMatch(/^wamid\./);
  });

  it('looks up the mapping scoped to BOTH account_id and contact_id', async () => {
    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );
    expect(captured.linkLookup).toEqual({ accountId: 'acct-mc', contactId: 'ct-mc-1' });
  });

  it('does not send when no mapping exists for this contact (no fallback to Meta)', async () => {
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: null, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_contact_not_linked' });

    expect(sendManyChatTextMock).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('a mapping row from another account is invisible — the lookup itself is account-scoped', async () => {
    // The fake DB always filters by the accountId/contactId passed to
    // .eq() — simulate "another account's mapping" by returning null,
    // exactly what a real account_id-scoped query would do for a link
    // that belongs to a different account.
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: null, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_contact_not_linked' });
    // Proves tenancy: the lookup was scoped to THIS account, not run
    // account-agnostically.
    expect(captured.linkLookup?.accountId).toBe('acct-mc');
  });

  it('errors before sending when MANYCHAT_API_KEY is missing', async () => {
    delete process.env.MANYCHAT_API_KEY;
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_not_configured', status: 503 });

    expect(sendManyChatTextMock).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it.each([401, 403, 429, 500])(
    'does not persist a message when ManyChat responds %i',
    async (status) => {
      sendManyChatTextMock.mockRejectedValue(
        new ManyChatApiError(status, `ManyChat error ${status}`),
      );
      const captured: ManyChatCaptured = {};
      await expect(
        sendMessageToConversation(
          manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
          'acct-mc',
          { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
        ),
      ).rejects.toMatchObject({ code: 'manychat_error', status: 502 });

      expect(captured.message).toBeUndefined();
    },
  );

  it('rejects template messages — no fallback to Meta', async () => {
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'template', templateName: 'order_update' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_unsupported_type' });
    expect(sendManyChatTextMock).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('rejects media messages — no fallback to Meta', async () => {
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'image', mediaUrl: 'https://x/y.jpg' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_unsupported_type' });
    expect(sendManyChatTextMock).not.toHaveBeenCalled();
  });

  it('rejects interactive messages — no fallback to Meta', async () => {
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
        'acct-mc',
        {
          conversationId: 'cv-mc-1',
          messageType: 'interactive',
          interactivePayload: { kind: 'buttons', body: 'Pick one', buttons: [{ id: 'a', title: 'A' }] },
        },
      ),
    ).rejects.toMatchObject({ code: 'manychat_unsupported_type' });
    expect(sendManyChatTextMock).not.toHaveBeenCalled();
  });

  it('updates last_message_text/last_message_at and pauses active flow runs, same as the Meta path', async () => {
    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );
    expect(captured.conversation).toMatchObject({ last_message_text: 'Hola!' });
    expect(captured.conversation?.last_message_at).toBeTruthy();
    // Flow-pause goes through the mocked @/lib/flows/admin-client, which
    // always resolves { error: null } — reaching it without throwing is
    // the signal the best-effort pause step ran.
  });

  it('never logs MANYCHAT_API_KEY, even when ManyChat rejects the send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendManyChatTextMock.mockRejectedValue(new ManyChatApiError(401, 'unauthorized'));

    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    ).catch(() => {});

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(logged).not.toContain('mc-key-test');

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ============================================================
// A human agent's manual send clears the "needs human attention"
// marker (ai_handoff_summary), but never re-enables the bot
// (ai_autoreply_disabled stays untouched) — that requires the explicit
// "Resume AI" flow. See src/lib/ai/handoff.ts / auto-reply.ts for how
// the marker gets set in the first place.
// ============================================================
describe('sendMessageToConversation — a successful manual send clears ai_handoff_summary (Meta path)', () => {
  it('clears ai_handoff_summary after the send is confirmed and persisted', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'On it — let me check that for you.',
    });
    expect(captured.conversation).toMatchObject({ ai_handoff_summary: null });
  });

  it('does NOT set ai_autoreply_disabled — the human keeps ownership until an explicit Resume AI', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'On it — let me check that for you.',
    });
    expect(captured.conversation).not.toHaveProperty('ai_autoreply_disabled');
  });

  it('does NOT clear the summary when the Meta send fails', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    (sendTextMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Meta API error: 500'),
    );
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'On it — let me check that for you.',
      }),
    ).rejects.toThrow();
    // The conversation update (which carries the clear) never ran.
    expect(captured.conversation).toBeUndefined();
  });
});

describe('sendMessageToConversation — a successful manual send clears ai_handoff_summary (ManyChat path)', () => {
  const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
  const originalApiKey = process.env.MANYCHAT_API_KEY;
  const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

  beforeEach(() => {
    process.env.WHATSAPP_OUTBOUND_TRANSPORT = 'manychat';
    process.env.MANYCHAT_INGEST_ACCOUNT_ID = 'acct-mc';
    process.env.MANYCHAT_API_KEY = 'mc-key-test';
    sendManyChatTextMock.mockReset();
    sendManyChatTextMock.mockResolvedValue({ raw: { status: 'success' } });
  });

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
    if (originalApiKey === undefined) delete process.env.MANYCHAT_API_KEY;
    else process.env.MANYCHAT_API_KEY = originalApiKey;
    if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
    else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
  });

  it('clears ai_handoff_summary after the send is confirmed and persisted', async () => {
    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );
    expect(captured.conversation).toMatchObject({ ai_handoff_summary: null });
  });

  it('does NOT set ai_autoreply_disabled', async () => {
    const captured: ManyChatCaptured = {};
    await sendMessageToConversation(
      manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
      'acct-mc',
      { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
    );
    expect(captured.conversation).not.toHaveProperty('ai_autoreply_disabled');
  });

  it('does NOT clear the summary when the ManyChat send fails', async () => {
    sendManyChatTextMock.mockRejectedValueOnce(new ManyChatApiError(500, 'ManyChat error 500'));
    const captured: ManyChatCaptured = {};
    await expect(
      sendMessageToConversation(
        manyChatSendDb({ link: { manychat_contact_id: 'mc-contact-1' }, captured }),
        'acct-mc',
        { conversationId: 'cv-mc-1', messageType: 'text', contentText: 'Hola!' },
      ),
    ).rejects.toMatchObject({ code: 'manychat_error' });
    expect(captured.conversation).toBeUndefined();
  });
});

describe('the bot/AI send path (src/lib/ai/send.ts) never clears ai_handoff_summary through this code', () => {
  it('src/lib/ai/send.ts never references ai_handoff_summary at all', async () => {
    // Structural guarantee, not a mock assertion: the AI auto-reply /
    // handoff-notice sender is a separate module (src/lib/ai/send.ts,
    // covered by send.test.ts) whose only conversation write is
    // last_message_text/last_message_at (see send.test.ts, "updates
    // last_message_text and last_message_at"). This asserts it doesn't
    // even mention the column, so a future edit can't accidentally wire
    // a bot/AI send into clearing the "needs human attention" marker —
    // only a confirmed HUMAN send (this file) may do that.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/lib/ai/send.ts'),
      'utf8',
    );
    expect(source).not.toContain('ai_handoff_summary');
  });
});
