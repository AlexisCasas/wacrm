import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
  sendManyChatFlowToContact: vi.fn(),
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
  sendManyChatFlowToContact: h.sendManyChatFlowToContact,
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

import { engineSendMedia } from "./meta-send";

const ACCOUNT = "046ff8c2-1111-4222-8333-444455556666";
const OTHER = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const SHA = "a".repeat(64);
const ORIGIN = "https://supabase.example.test";
const voiceUrl = (account = ACCOUNT, origin = ORIGIN) =>
  `${origin}/storage/v1/object/public/voice-notes/account-${account}/${SHA}.ogg`;

const VOICE_ARGS = {
  accountId: ACCOUNT,
  userId: "u-1",
  conversationId: "cv-1",
  contactId: "ct-1",
  kind: "audio" as const,
  voice: true,
  link: voiceUrl(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
  vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", ACCOUNT);
  h.state.insertCalls = [];
  h.state.insertError = null;
  h.state.conversationUpdateCalls = [];
  h.state.contactRow = { id: "ct-1", phone: "+15551234567" };
  h.state.configRow = { phone_number_id: "pn-1", access_token: "token" };
  h.resolveOutboundTransport.mockReturnValue("meta");
  h.sendTextMessage.mockResolvedValue({ messageId: "wamid.text" });
  h.sendMediaMessage.mockResolvedValue({ messageId: "wamid.media" });
  h.sendManyChatTextToContact.mockResolvedValue({ whatsappMessageId: "manychat-out:abc" });
  h.sendManyChatFlowToContact.mockResolvedValue({ whatsappMessageId: "manychat-flow:xyz" });
});


afterEach(() => {
  vi.unstubAllEnvs();
});

describe("engineSendMedia — voice notes are opt-in per account", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("meta");
  });

  it.each([
    ["flag missing", undefined],
    ["flag empty", ""],
    ["another account listed", OTHER],
    ["malformed entries only", "not-a-uuid, 123"],
  ])("refuses before any provider call when %s", async (_name, value) => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", value as string);
    if (value === undefined) delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toThrow(/not enabled for this account/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(h.sendManyChatFlowToContact).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("matches case-insensitively among several listed accounts", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${OTHER}, ${ACCOUNT.toUpperCase()}`);
    await expect(engineSendMedia(VOICE_ARGS)).resolves.toMatchObject({ whatsapp_message_id: "wamid.media" });
  });

  it("sends to an unlisted account when FLOW_MEDIA_AUDIO_SCOPE=all, still as a native voice note over Meta", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", "");
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    await expect(engineSendMedia(VOICE_ARGS)).resolves.toMatchObject({ whatsapp_message_id: "wamid.media" });
    expect(h.sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "audio", voice: true }));
  });

  it("with scope=all, still refuses another account's file, a non-voice audio and the ManyChat bridge", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", "");
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    await expect(engineSendMedia({ ...VOICE_ARGS, link: voiceUrl(OTHER) })).rejects.toThrow(/verified voice note of this account/);
    await expect(engineSendMedia({ ...VOICE_ARGS, voice: false })).rejects.toThrow(/voice note/);
    h.resolveOutboundTransport.mockReturnValue("manychat");
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toThrow(/ManyChat/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("does not affect image/video/document sends when the flag is off", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", "");
    await engineSendMedia({ accountId: ACCOUNT, userId: "u-1", conversationId: "cv-1", contactId: "ct-1", kind: "image", link: "https://cdn.example/x.png" });
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
  });
});

describe("engineSendMedia — voice notes (transport=meta)", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("meta");
  });

  it("calls the existing sendMediaMessage with kind=audio and voice=true", async () => {
    const result = await engineSendMedia(VOICE_ARGS);
    expect(result.whatsapp_message_id).toBe("wamid.media");
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMediaMessage.mock.calls[0][0]).toMatchObject({
      kind: "audio",
      voice: true,
      link: voiceUrl(),
      to: "15551234567",
    });
  });

  it("never sends a caption or filename with an audio, even if the node carries them", async () => {
    await engineSendMedia({ ...VOICE_ARGS, caption: "Guía 1", filename: "guia.ogg" });
    const sent = h.sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.caption).toBeUndefined();
    expect(sent.filename).toBeUndefined();
    expect(h.state.insertCalls[0]).toMatchObject({ content_type: "audio", content_text: null, media_url: voiceUrl() });
  });

  it("persists the message as a bot audio and previews it as [audio]", async () => {
    await engineSendMedia({ ...VOICE_ARGS, caption: "ignored" });
    expect(h.state.insertCalls).toHaveLength(1);
    expect(h.state.insertCalls[0]).toMatchObject({
      conversation_id: "cv-1",
      sender_type: "bot",
      content_type: "audio",
      message_id: "wamid.media",
      status: "sent",
    });
    expect(h.state.conversationUpdateCalls[0]).toMatchObject({ last_message_text: "[audio]" });
  });

  it("refuses an audio that is not flagged as a voice note, before calling Meta", async () => {
    await expect(engineSendMedia({ ...VOICE_ARGS, voice: false })).rejects.toThrow(/voice note/);
    await expect(engineSendMedia({ ...VOICE_ARGS, voice: undefined })).rejects.toThrow(/voice note/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("refuses voice on any other kind", async () => {
    await expect(
      engineSendMedia({ ...VOICE_ARGS, kind: "document", link: "https://cdn.example/x.pdf" }),
    ).rejects.toThrow(/only valid for audio/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("isolates by account: another account's voice note is refused", async () => {
    await expect(engineSendMedia({ ...VOICE_ARGS, link: voiceUrl(OTHER) })).rejects.toThrow(/verified voice note/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["an arbitrary host", voiceUrl(ACCOUNT, "https://evil.example")],
    ["a different bucket", `${ORIGIN}/storage/v1/object/public/chat-media/account-${ACCOUNT}/${SHA}.ogg`],
    ["a non-content-addressed name", `${ORIGIN}/storage/v1/object/public/voice-notes/account-${ACCOUNT}/guia.ogg`],
    ["a query string", `${voiceUrl()}?x=1`],
    ["an mp3", voiceUrl().replace(".ogg", ".mp3")],
  ])("refuses %s", async (_name, link) => {
    await expect(engineSendMedia({ ...VOICE_ARGS, link })).rejects.toThrow(/verified voice note/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("surfaces a provider error and records nothing as sent", async () => {
    h.sendMediaMessage.mockRejectedValue(new Error("Meta API error: 131053 media upload error"));
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toThrow(/131053/);
    expect(h.state.insertCalls).toHaveLength(0);
    expect(h.state.conversationUpdateCalls).toHaveLength(0);
  });

  it("surfaces a persistence failure after the provider accepted the message", async () => {
    h.state.insertError = { message: "constraint violation" };
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toThrow(/DB insert failed/);
  });

  it("still does not touch a blocked contact (guard runs first)", async () => {
    const blocking = await import("@/lib/contacts/blocking");
    const spy = vi.spyOn(blocking, "assertContactCanReceive").mockRejectedValueOnce(new blocking.ContactBlockedError());
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toBeInstanceOf(blocking.ContactBlockedError);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("engineSendMedia — voice notes under the ManyChat transport (FAILS CLOSED)", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("manychat");
  });

  it("never sends a voice note through ManyChat or Meta, with or without a bridge flow", async () => {
    await expect(engineSendMedia(VOICE_ARGS)).rejects.toThrow(/ManyChat bridge/);
    await expect(
      engineSendMedia({ ...VOICE_ARGS, manychatBridgeFlowNs: "content20260101" }),
    ).rejects.toThrow(/ManyChat bridge/);
    expect(h.sendManyChatFlowToContact).not.toHaveBeenCalled();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("leaves the existing bridge behavior for images untouched", async () => {
    const result = await engineSendMedia({
      accountId: ACCOUNT,
      userId: "u-1",
      conversationId: "cv-1",
      contactId: "ct-1",
      kind: "image",
      link: "https://cdn.example/x.png",
      manychatBridgeFlowNs: "content20260101",
    });
    expect(h.sendManyChatFlowToContact).toHaveBeenCalledTimes(1);
    expect(result.whatsapp_message_id).toBe("manychat-flow:xyz");
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });
});

describe("engineSendMedia — existing media kinds are unchanged", () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue("meta");
  });

  it.each(["image", "video", "document"] as const)("%s keeps caption/filename and sends no voice flag", async (kind) => {
    await engineSendMedia({
      accountId: ACCOUNT,
      userId: "u-1",
      conversationId: "cv-1",
      contactId: "ct-1",
      kind,
      link: `https://cdn.example/x.${kind}`,
      caption: "Hola",
      filename: "x.pdf",
    });
    const sent = h.sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ kind, caption: "Hola", filename: "x.pdf" });
    expect(sent.voice).toBeUndefined();
  });
});
