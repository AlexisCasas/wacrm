import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMessage } from "./meta-api";

// Wire-level contract for a WhatsApp voice note: `type: "audio"` with
// `audio.voice = true`, a link, and nothing else.
let captured: Record<string, unknown> | null = null;

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://s.example/storage/v1/object/public/voice-notes/account-x/abc.ogg",
} as const;

describe("sendMediaMessage — voice note payload", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { ok: true, json: async () => ({ messages: [{ id: "wamid.VOICE" }] }) } as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends type audio with audio.voice = true and only the link", async () => {
    const result = await sendMediaMessage({ ...BASE, kind: "audio", voice: true });
    expect(result.messageId).toBe("wamid.VOICE");
    expect(captured).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: BASE.to,
      type: "audio",
      audio: { link: BASE.link, voice: true },
    });
  });

  it("never attaches a caption or filename to a voice note", async () => {
    await sendMediaMessage({ ...BASE, kind: "audio", voice: true, caption: "Guía", filename: "guia.ogg" });
    expect(captured?.audio).toEqual({ link: BASE.link, voice: true });
  });

  it("never goes out as a document or generic attachment", async () => {
    await sendMediaMessage({ ...BASE, kind: "audio", voice: true });
    expect(captured?.type).toBe("audio");
    expect(captured).not.toHaveProperty("document");
  });

  it("omits the voice flag for a plain audio and drops it for other kinds", async () => {
    await sendMediaMessage({ ...BASE, kind: "audio" });
    expect(captured?.audio).toEqual({ link: BASE.link });
    await sendMediaMessage({ ...BASE, kind: "document", voice: true, filename: "x.pdf" });
    expect(captured?.document).toEqual({ link: BASE.link, filename: "x.pdf" });
  });

  it("raises the provider's error instead of reporting a send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => JSON.stringify({ error: { message: "Media upload error", code: 131053 } }),
        json: async () => ({ error: { message: "Media upload error", code: 131053 } }),
        headers: new Headers(),
      }) as unknown as Response),
    );
    await expect(sendMediaMessage({ ...BASE, kind: "audio", voice: true })).rejects.toThrow();
  });
});
