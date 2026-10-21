import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Runner-level coverage of a REAL `send_media` audio node.
//
// Nothing between the inbound message and Meta is replaced except the network:
//   dispatchInboundToFlows -> findEntryFlow -> startNewRun -> advance loop
//   -> engineSendMedia (real) -> sendMediaMessage (simulated Meta) -> messages /
//   conversations / flow_run_events persisted in an in-memory database.
// So these tests read back what the runner and the sender actually wrote.
// ============================================================

const h = vi.hoisted(() => ({
  db: null as unknown,
  transport: "meta" as "meta" | "manychat",
  sendMediaMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  sendManyChatFlowToContact: vi.fn(),
}));

vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/whatsapp/send-message", () => ({ resolveOutboundTransport: () => h.transport }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/manychat/contact-send", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendManyChatFlowToContact: (...a: unknown[]) => h.sendManyChatFlowToContact(...a),
}));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: (...a: unknown[]) => h.sendMediaMessage(...a),
  sendTextMessage: (...a: unknown[]) => h.sendTextMessage(...a),
}));

import { dispatchInboundToFlows } from "./engine";
import { createMemoryDb, type Row } from "./test-support/memory-db";

const ACCOUNT = "046ff8c2-1111-4222-8333-444455556666";
const OTHER = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const SHA = "a".repeat(64);
const ORIGIN = "https://supabase.example.test";
const voiceUrl = (account = ACCOUNT, sha = SHA) =>
  `${ORIGIN}/storage/v1/object/public/voice-notes/account-${account}/${sha}.ogg`;

const FLOW: Row = {
  id: "flow-1", account_id: ACCOUNT, user_id: "u-1", status: "active", trigger_type: "keyword",
  trigger_config: { keywords: ["provincia"] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z",
};
const audioNode = (key: string, next: string, extra: Row = {}): Row => ({
  flow_id: "flow-1", node_key: key, node_type: "send_media",
  config: { media_type: "audio", media_url: voiceUrl(), media_sha256: SHA, next_node_key: next, ...extra },
});
const GRAPH: Row[] = [
  { flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "voice" } },
  audioNode("voice", "after"),
  { flow_id: "flow-1", node_key: "after", node_type: "send_message", config: { text: "Listo", next_node_key: "done" } },
  { flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
];

function setup(nodes: Row[] = GRAPH, opts: { failInsert?: Parameters<typeof createMemoryDb>[1] } = {}, contact: Row = {}) {
  const mem = createMemoryDb(
    {
      flows: [FLOW],
      flow_nodes: nodes,
      contacts: [{ id: "ct-1", account_id: ACCOUNT, name: "Ana", phone: "+15551234567", blocked: false, ...contact }],
      whatsapp_config: [{ account_id: ACCOUNT, phone_number_id: "pn-1", access_token: "token" }],
      conversations: [{ id: "cv-1", account_id: ACCOUNT }],
    },
    opts.failInsert,
  );
  h.db = mem.client;
  return mem;
}

const dispatch = (text = "provincia", id = "wamid.IN1") =>
  dispatchInboundToFlows({
    accountId: ACCOUNT, userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
    message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false,
  });

const events = (mem: ReturnType<typeof createMemoryDb>, type?: string) =>
  mem.table("flow_run_events").filter((e) => !type || e.event_type === type);
const run = (mem: ReturnType<typeof createMemoryDb>) => mem.table("flow_runs")[0];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
  vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", ACCOUNT);
  h.transport = "meta";
  h.sendMediaMessage.mockReset().mockResolvedValue({ messageId: "wamid.VOICE1" });
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.TEXT1" });
  h.sendManyChatFlowToContact.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runner: send_media audio node (Meta transport, simulated provider)", () => {
  it("reads the node, sends a native voice note, persists it in the Inbox, logs it, and continues to the next node", async () => {
    const mem = setup();
    const result = await dispatch();

    expect(result).toMatchObject({ consumed: true, outcome: "completed" });

    // 1. the provider received exactly a voice note: type audio, voice true, the node's link, nothing else
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    const wire = h.sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(wire).toMatchObject({ kind: "audio", voice: true, link: voiceUrl(), to: "15551234567", phoneNumberId: "pn-1" });
    expect(wire.caption).toBeUndefined();
    expect(wire.filename).toBeUndefined();

    // 2. the Inbox shows it as a bot audio message with the provider's id
    const messages = mem.table("messages");
    expect(messages[0]).toMatchObject({
      conversation_id: "cv-1", sender_type: "bot", content_type: "audio", content_text: null,
      media_url: voiceUrl(), message_id: "wamid.VOICE1", status: "sent",
    });
    // (the preview is the LAST thing sent; the audio's own "[audio]" preview is asserted in the two-voice-note test)
    expect(mem.table("conversations")[0]).toMatchObject({ last_message_text: "Listo" });

    // 3. the run recorded the send with the provider id and the voice flag
    expect(events(mem, "message_sent")[0]).toMatchObject({
      node_key: "voice",
      payload: { node_type: "send_media", media_type: "audio", voice: true, whatsapp_message_id: "wamid.VOICE1" },
    });

    // 4. it continued: the NEXT node ran AFTER the voice note, and the run ended cleanly
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMediaMessage.mock.invocationCallOrder[0]).toBeLessThan(h.sendTextMessage.mock.invocationCallOrder[0]);
    expect(messages.map((m) => m.content_type)).toEqual(["audio", "text"]);
    expect(run(mem)).toMatchObject({ status: "completed" });
    expect(events(mem, "error")).toHaveLength(0);
  });

  it("two voice notes in a row, with the platform's wait between them, go out in order", async () => {
    vi.useFakeTimers();
    const second = voiceUrl(ACCOUNT, "b".repeat(64));
    const mem = setup([
      { flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "v1" } },
      audioNode("v1", "wait"),
      { flow_id: "flow-1", node_key: "wait", node_type: "delay", config: { seconds: 5, next_node_key: "v2" } },
      audioNode("v2", "done", { media_url: second, media_sha256: "b".repeat(64) }),
      { flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
    ]);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1); // the second one is still waiting
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(h.sendMediaMessage.mock.calls.map((c) => (c[0] as { link: string }).link)).toEqual([voiceUrl(), second]);
    expect(h.sendMediaMessage.mock.calls.every((c) => (c[0] as { voice: boolean }).voice === true)).toBe(true);
    expect(mem.table("messages").map((m) => m.content_type)).toEqual(["audio", "audio"]);
    expect(mem.table("conversations")[0]).toMatchObject({ last_message_text: "[audio]" });
    expect(run(mem)).toMatchObject({ status: "completed" });
  });

  it("when the provider rejects the send: the error is logged with its detail, nothing is persisted as sent, the next node does NOT run, the run fails", async () => {
    h.sendMediaMessage.mockRejectedValue(new Error("Meta API error: 131053 Media upload error"));
    const mem = setup();
    const result = await dispatch();

    expect(result.consumed).toBe(true);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1); // never retried behind the scenes
    expect(mem.table("messages")).toHaveLength(0);
    expect(mem.table("conversations")[0]).not.toHaveProperty("last_message_text");
    expect(events(mem, "message_sent")).toHaveLength(0);
    expect(events(mem, "error")[0]).toMatchObject({
      node_key: "voice",
      payload: { reason: "send_media_failed", detail: expect.stringContaining("131053") },
    });
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(run(mem)).toMatchObject({ status: "failed", end_reason: "send_media_failed" });
  });

  it("when Meta accepted it but the Inbox row cannot be written: no retry (no second voice note), the failure is logged", async () => {
    const mem = setup(GRAPH, { failInsert: { failInsert: (t) => (t === "messages" ? { message: "constraint violation" } : undefined) } });
    await dispatch();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(events(mem, "error")[0]).toMatchObject({ payload: { reason: "send_media_failed", detail: expect.stringContaining("DB insert failed") } });
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(run(mem)).toMatchObject({ status: "failed", end_reason: "send_media_failed" });
  });

  it("fails closed, with no provider call, when voice notes are not enabled for the account", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", OTHER);
    const mem = setup();
    await dispatch();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(events(mem, "error")[0]).toMatchObject({ payload: { reason: "send_media_failed", detail: expect.stringContaining("not enabled") } });
    expect(run(mem)).toMatchObject({ status: "failed" });
  });

  it.each([
    ["another account's file", voiceUrl(OTHER)],
    ["an arbitrary host", voiceUrl().replace(ORIGIN, "https://evil.example")],
    ["a plain external audio", "https://cdn.example/guia.ogg"],
  ])("fails closed on %s in the node config", async (_name, url) => {
    const mem = setup([GRAPH[0], audioNode("voice", "after", { media_url: url }), GRAPH[2], GRAPH[3]]);
    await dispatch();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(events(mem, "error")[0]).toMatchObject({ payload: { reason: "send_media_failed", detail: expect.stringContaining("verified voice note") } });
    expect(run(mem)).toMatchObject({ status: "failed" });
  });

  it("never sends a voice note through the ManyChat transport, and never falls back to Meta", async () => {
    h.transport = "manychat";
    const mem = setup([GRAPH[0], audioNode("voice", "after", { manychat_bridge_flow_ns: "content2026" }), GRAPH[2], GRAPH[3]]);
    await dispatch();
    expect(h.sendManyChatFlowToContact).not.toHaveBeenCalled();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(events(mem, "error")[0]).toMatchObject({ payload: { detail: expect.stringContaining("ManyChat bridge") } });
    expect(run(mem)).toMatchObject({ status: "failed" });
  });

  it("a blocked contact ends the run as the block route does, with nothing sent", async () => {
    const mem = setup(GRAPH, {}, { blocked: true });
    await dispatch();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(run(mem)).toMatchObject({ status: "paused_by_agent", end_reason: "contact_blocked" });
  });
});

describe("runner: existing media nodes are unchanged", () => {
  it.each(["image", "video", "document"] as const)("%s keeps its caption and filename, sends no voice flag, and continues", async (kind) => {
    const mem = setup([
      GRAPH[0],
      { flow_id: "flow-1", node_key: "voice", node_type: "send_media", config: { media_type: kind, media_url: `https://cdn.example/x.${kind}`, caption: "Hola {{vars.contact_name}}", filename: "x.pdf", next_node_key: "after" } },
      GRAPH[2], GRAPH[3],
    ]);
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", ""); // the voice-note flag has no bearing on them
    await dispatch();
    const wire = h.sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(wire).toMatchObject({ kind, caption: "Hola Ana", filename: "x.pdf", link: `https://cdn.example/x.${kind}` });
    expect(wire.voice).toBeUndefined();
    expect(mem.table("messages")[0]).toMatchObject({ content_type: kind, content_text: "Hola Ana" });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(run(mem)).toMatchObject({ status: "completed" });
  });
});
