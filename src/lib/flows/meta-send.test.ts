import { describe, expect, it, vi, beforeEach } from "vitest";

// ============================================================
// Transport-aware Flow text sends (engineSendText) + fail-closed media
// (engineSendMedia) under a ManyChat-bridged account.
//
// engineSendText is shared with src/lib/ai/send.ts's Meta branch — its
// AI call site pre-checks transport itself and never reaches the
// ManyChat branch added here, so this file only needs to prove the
// FLOWS-relevant behavior: Meta unchanged, ManyChat now supported,
// send_media fails closed with no silent fallback.
// ============================================================

const h = vi.hoisted(() => ({
  resolveOutboundTransport: vi.fn(),
  sendManyChatTextToContact: vi.fn(),
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  state: {
    insertCalls: [] as Record<string, unknown>[],
    insertError: null as { message: string } | null,
    conversationUpdateCalls: [] as Record<string, unknown>[],
    contactRow: { id: "ct-1", phone: "+15551234567" } as Record<string, unknown> | null,
    configRow: { phone_number_id: "pn-1", access_token: "token" } as Record<string, unknown> | null,
  },
}));

vi.mock("@/lib/whatsapp/send-message", () => ({
  resolveOutboundTransport: h.resolveOutboundTransport,
}));

vi.mock("@/lib/manychat/contact-send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendManyChatTextToContact: h.sendManyChatTextToContact,
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...a: unknown[]) => (h.sendTextMessage as unknown as (...x: unknown[]) => unknown)(...a),
  sendMediaMessage: (...a: unknown[]) => (h.sendMediaMessage as unknown as (...x: unknown[]) => unknown)(...a),
  sendInteractiveButtons: (...a: unknown[]) =>
    (h.sendInteractiveButtons as unknown as (...x: unknown[]) => unknown)(...a),
  sendInteractiveList: (...a: unknown[]) =>
    (h.sendInteractiveList as unknown as (...x: unknown[]) => unknown)(...a),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v,
}));

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: h.state.contactRow, error: null }),
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "whatsapp_config") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: h.state.configRow, error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.insertCalls.push(row);
            return Promise.resolve({ error: h.state.insertError });
          },
        };
      }
      if (table === "conversations") {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              h.state.conversationUpdateCalls.push(row);
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

import { engineSendText, engineSendMedia } from "./meta-send";

const TEXT_ARGS = {
  accountId: "acct-1",
  userId: "u-1",
  conversationId: "cv-1",
  contactId: "ct-1",
  text: "Hola, este es un mensaje del Flow",
};

const MEDIA_ARGS = {
  accountId: "acct-1",
  userId: "u-1",
  conversationId: "cv-1",
  contactId: "ct-1",
  kind: "image" as const,
  link: "https://cdn.example/x.png",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.insertCalls = [];
  h.state.insertError = null;
  h.state.conversationUpdateCalls = [];
  h.state.contactRow = { id: "ct-1", phone: "+15551234567" };
  h.state.configRow = { phone_number_id: "pn-1", access_token: "token" };
  h.resolveOutboundTransport.mockReturnValue("meta");
  h.sendTextMessage.mockResolvedValue({ messageId: "wamid.text" });
  h.sendMediaMessage.mockResolvedValue({ messageId: "wamid.media" });
  h.sendManyChatTextToContact.mockResolvedValue({ whatsappMessageId: "manychat-out:abc" });
});

describe("engineSendText — transport=meta (unchanged behavior)", () => {
  it("sends via Meta and persists sender_type='bot', ai_generated=false by default", async () => {
    const result = await engineSendText(TEXT_ARGS);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendManyChatTextToContact).not.toHaveBeenCalled();
    expect(result.whatsapp_message_id).toBe("wamid.text");
    expect(h.state.insertCalls[0]).toMatchObject({
      sender_type: "bot",
      content_type: "text",
      ai_generated: false,
    });
  });

  it("still honors aiGenerated:true when the caller (AI engine) passes it", async () => {
    await engineSendText({ ...TEXT_ARGS, aiGenerated: true });
    expect(h.state.insertCalls[0]).toMatchObject({ ai_generated: true });
  });
});

describe("engineSendText — transport=manychat (new)", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("manychat");
  });

  it("routes through sendManyChatTextToContact, never Meta", async () => {
    const result = await engineSendText(TEXT_ARGS);
    expect(h.sendManyChatTextToContact).toHaveBeenCalledWith({
      db: expect.anything(),
      accountId: "acct-1",
      contactId: "ct-1",
      text: TEXT_ARGS.text,
    });
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(result.whatsapp_message_id).toBe("manychat-out:abc");
  });

  it("persists sender_type='bot', content_type='text', status='sent', ai_generated=false", async () => {
    await engineSendText(TEXT_ARGS);
    expect(h.state.insertCalls).toHaveLength(1);
    expect(h.state.insertCalls[0]).toMatchObject({
      conversation_id: "cv-1",
      sender_type: "bot",
      content_type: "text",
      content_text: TEXT_ARGS.text,
      message_id: "manychat-out:abc",
      status: "sent",
      ai_generated: false,
    });
  });

  it("never marks the message as an agent/human send, across repeated calls", async () => {
    await engineSendText(TEXT_ARGS);
    await engineSendText({ ...TEXT_ARGS, text: "second message" });
    expect(h.state.insertCalls.every((c) => c.sender_type === "bot")).toBe(true);
    expect(h.state.insertCalls.every((c) => c.sender_type !== "agent")).toBe(true);
  });

  it("updates last_message_text and last_message_at on the conversation", async () => {
    await engineSendText(TEXT_ARGS);
    expect(h.state.conversationUpdateCalls).toHaveLength(1);
    expect(h.state.conversationUpdateCalls[0]).toMatchObject({
      last_message_text: TEXT_ARGS.text,
    });
    expect(h.state.conversationUpdateCalls[0].last_message_at).toBeTruthy();
  });

  it("does not touch flow_runs — a Flow's own send must never pause its own run", async () => {
    // The fake admin-client throws on any table other than
    // contacts/whatsapp_config/messages/conversations — a successful
    // resolve here proves flow_runs was never queried.
    await expect(engineSendText(TEXT_ARGS)).resolves.toBeDefined();
  });

  it("propagates a ManyChat send failure without persisting a message", async () => {
    h.sendManyChatTextToContact.mockRejectedValue(new Error("ManyChat API error: 500"));
    await expect(engineSendText(TEXT_ARGS)).rejects.toThrow("ManyChat API error: 500");
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("throws (does not swallow) a DB insert failure", async () => {
    h.state.insertError = { message: "constraint violation" };
    await expect(engineSendText(TEXT_ARGS)).rejects.toThrow(/DB insert failed/);
  });
});

describe("engineSendMedia — transport=meta (unchanged behavior)", () => {
  it("sends via Meta as before", async () => {
    h.resolveOutboundTransport.mockReturnValue("meta");
    const result = await engineSendMedia(MEDIA_ARGS);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(result.whatsapp_message_id).toBe("wamid.media");
  });
});

describe("engineSendMedia — transport=manychat (FAILS CLOSED, no silent Meta fallback)", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("manychat");
  });

  it("throws immediately, before attempting anything", async () => {
    await expect(engineSendMedia(MEDIA_ARGS)).rejects.toThrow(/ManyChat/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("never falls back to Meta", async () => {
    await engineSendMedia(MEDIA_ARGS).catch(() => {});
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("never persists a message row for the failed attempt", async () => {
    await engineSendMedia(MEDIA_ARGS).catch(() => {});
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("the error message is legible and names the actual limitation", async () => {
    await expect(engineSendMedia(MEDIA_ARGS)).rejects.toThrow(
      /not yet supported while this account is bridged through ManyChat/,
    );
  });
});
