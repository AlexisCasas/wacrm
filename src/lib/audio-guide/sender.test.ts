import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ engineSendMedia: vi.fn() }));
vi.mock("@/lib/flows/meta-send", () => ({ engineSendMedia: h.engineSendMedia }));

import { sendVoiceNoteViaEngine } from "./sender";

describe("sendVoiceNoteViaEngine", () => {
  it("is the single Flow media transport, as a voice note, and names the originating Flow run (needed by the BSUID per-send check)", async () => {
    h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: "wamid.X" });
    const out = await sendVoiceNoteViaEngine({ accountId: "a", userId: "u", conversationId: "cv", contactId: "ct", flowRunId: "run-9", link: "https://x/y.ogg" });
    expect(out).toEqual({ whatsappMessageId: "wamid.X" });
    expect(h.engineSendMedia).toHaveBeenCalledWith({ accountId: "a", userId: "u", conversationId: "cv", contactId: "ct", flowRunId: "run-9", kind: "audio", link: "https://x/y.ogg", voice: true });
  });

  it("without a run id (never the case for a Flow) it still sends exactly as before", async () => {
    h.engineSendMedia.mockClear();
    h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: "wamid.Y" });
    await sendVoiceNoteViaEngine({ accountId: "a", userId: "u", conversationId: "cv", contactId: "ct", link: "l" });
    expect(h.engineSendMedia.mock.calls[0][0].flowRunId).toBeUndefined();
  });
});
