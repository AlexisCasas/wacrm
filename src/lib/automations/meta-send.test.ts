import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// feat/automation-durable-followup-media — Automations' text and media sends
// now delegate to the already-transport-aware Flows senders
// (`@/lib/flows/meta-send`'s engineSendText / engineSendMedia) instead of
// re-implementing ManyChat-vs-Meta branching a second time. Flows' own
// meta-send.test.ts already proves the transport branching, the ManyChat
// bridge's fail-closed behaviour, and the persisted-message shape in full;
// this file only proves the NEW code here — the delegation itself — is
// wired correctly and never swallows an error into a silent Meta fallback.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  flowsEngineSendText: vi.fn(async () => ({ whatsapp_message_id: "flow-text-1" })),
  flowsEngineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "flow-media-1" })),
  flowsEngineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "flow-btn-1" })),
  flowsEngineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "flow-list-1" })),
}));
const {
  flowsEngineSendText,
  flowsEngineSendMedia,
  flowsEngineSendInteractiveButtons,
  flowsEngineSendInteractiveList,
} = h;

vi.mock("@/lib/flows/meta-send", () => ({
  engineSendText: h.flowsEngineSendText,
  engineSendMedia: h.flowsEngineSendMedia,
  engineSendInteractiveButtons: h.flowsEngineSendInteractiveButtons,
  engineSendInteractiveList: h.flowsEngineSendInteractiveList,
}));

import { engineSendText, engineSendMedia, engineSendInteractive } from "./meta-send";

beforeEach(() => {
  flowsEngineSendText.mockClear();
  flowsEngineSendMedia.mockClear();
  flowsEngineSendInteractiveButtons.mockClear();
  flowsEngineSendInteractiveList.mockClear();
});

const BASE = {
  accountId: "acct-1",
  userId: "user-1",
  conversationId: "conv-1",
  contactId: "contact-1",
};

describe("engineSendText — delegates to the Flows engine (spec §11.E)", () => {
  it("forwards the exact args and returns the Flows result unchanged", async () => {
    const args = { ...BASE, text: "Hola, gracias por tu compra" };
    const result = await engineSendText(args);

    expect(flowsEngineSendText).toHaveBeenCalledTimes(1);
    expect(flowsEngineSendText).toHaveBeenCalledWith(args);
    expect(result).toEqual({ whatsapp_message_id: "flow-text-1" });
  });

  it("propagates a rejection from the Flows engine instead of catching it", async () => {
    flowsEngineSendText.mockRejectedValueOnce(new Error("WhatsApp not configured for this account"));
    await expect(engineSendText({ ...BASE, text: "hi" })).rejects.toThrow(
      "WhatsApp not configured for this account",
    );
  });
});

describe("engineSendMedia — delegates to the Flows engine, ManyChat-bridge-capable (spec §11.F)", () => {
  it("maps every field through, including the ManyChat bridge flow ns", async () => {
    const args = {
      ...BASE,
      kind: "image" as const,
      link: "https://cdn.example.com/combo.png",
      caption: "Combo XTD",
      filename: undefined,
      manychatBridgeFlowNs: "content2026abc123",
    };
    const result = await engineSendMedia(args);

    expect(flowsEngineSendMedia).toHaveBeenCalledTimes(1);
    expect(flowsEngineSendMedia).toHaveBeenCalledWith(args);
    expect(result).toEqual({ whatsapp_message_id: "flow-media-1" });
  });

  it("works with no ManyChat bridge configured at all (Meta-native automation)", async () => {
    const args = {
      ...BASE,
      kind: "document" as const,
      link: "https://cdn.example.com/invoice.pdf",
      filename: "invoice.pdf",
    };
    await engineSendMedia(args);
    expect(flowsEngineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ manychatBridgeFlowNs: undefined }),
    );
  });

  it("propagates the Flows engine's fail-closed error verbatim — no silent Meta fallback (spec §11.G)", async () => {
    flowsEngineSendMedia.mockRejectedValueOnce(
      new Error(
        "[flows] send_media has no manychat_bridge_flow_ns configured — cannot send media while this account is bridged through ManyChat. This send was NOT attempted via Meta.",
      ),
    );

    await expect(
      engineSendMedia({
        ...BASE,
        kind: "image" as const,
        link: "https://cdn.example.com/combo.png",
      }),
    ).rejects.toThrow(/manychat_bridge_flow_ns/);
    // Automations' engineSendMedia has no try/catch of its own around this
    // call — the rejection above IS the same error Flows threw, not a
    // caught-and-rethrown copy, so there is no seam where a fallback to
    // Meta could have been inserted.
  });
});

describe("engineSendInteractive — unchanged pre-existing delegation (regression guard)", () => {
  it("still routes buttons payloads to the Flows interactive-buttons sender", async () => {
    await engineSendInteractive({
      ...BASE,
      payload: { kind: "buttons", body: "Pick one", buttons: [{ id: "yes", title: "Yes" }] },
    });
    expect(flowsEngineSendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(flowsEngineSendInteractiveList).not.toHaveBeenCalled();
  });
});
