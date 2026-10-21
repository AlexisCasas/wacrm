import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

const ACCOUNT = "046ff8c2-1111-4222-8333-444455556666";
const OTHER = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const SHA = "a".repeat(64);
const url = (account = ACCOUNT, sha = SHA) =>
  `https://s.example/storage/v1/object/public/voice-notes/account-${account}/${sha}.ogg`;

const flow = {
  name: "Audios",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["provincia"], match_type: "contains" },
  entry_node_id: "s",
};
const nodes = (media: Record<string, unknown>) => [
  { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
  { node_key: "m", node_type: "send_media", config: { next_node_key: "h", ...media } },
  { node_key: "h", node_type: "handoff", config: {} },
];
const audio = (extra: Record<string, unknown> = {}) => ({
  media_type: "audio",
  media_url: url(),
  media_sha256: SHA,
  ...extra,
});
const mediaIssues = (media: Record<string, unknown>, accountId?: string, extra: Record<string, unknown> = {}) =>
  validateFlowForActivation(flow, nodes(media), { ...(accountId ? { accountId } : {}), ...extra }).filter(
    (i) => i.node_key === "m" && i.severity === "error",
  );

describe("validateFlowForActivation — voice note (send_media audio)", () => {
  it("accepts a verified voice note of the flow's account", () => {
    expect(mediaIssues(audio(), ACCOUNT)).toEqual([]);
  });

  it("accepts it in the browser, which does not know the account (shape only)", () => {
    expect(mediaIssues(audio())).toEqual([]);
  });

  it("rejects another account's file on the server", () => {
    const issues = mediaIssues(audio({ media_url: url(OTHER) }), ACCOUNT);
    expect(issues.some((i) => i.field === "media_url")).toBe(true);
  });

  it("rejects a URL that is not a hash-addressed voice note", () => {
    for (const bad of [
      "https://cdn.example/guia.ogg",
      "https://s.example/storage/v1/object/public/chat-media/account-x/guia.ogg",
      `${url()}?download=1`,
    ]) {
      expect(mediaIssues(audio({ media_url: bad })).some((i) => i.field === "media_url")).toBe(true);
    }
  });

  it("rejects a recorded hash that does not match the file", () => {
    expect(mediaIssues(audio({ media_sha256: "b".repeat(64) })).some((i) => i.field === "media_url")).toBe(true);
    expect(mediaIssues(audio({ media_sha256: undefined })).some((i) => i.field === "media_url")).toBe(true);
  });

  it("rejects a caption, filename or ManyChat bridge on an audio", () => {
    expect(mediaIssues(audio({ caption: "Guía 1" })).length).toBeGreaterThan(0);
    expect(mediaIssues(audio({ filename: "guia.ogg" })).length).toBeGreaterThan(0);
    expect(mediaIssues(audio({ manychat_bridge_flow_ns: "content2026" })).length).toBeGreaterThan(0);
  });

  it("is an error when the server says voice notes are not enabled for the account", () => {
    const off = mediaIssues(audio(), ACCOUNT, { voiceNoteEnabled: false });
    expect(off.some((i) => i.field === "media_type" && /not enabled/.test(i.message))).toBe(true);
    expect(mediaIssues(audio(), ACCOUNT, { voiceNoteEnabled: true })).toEqual([]);
    // image nodes are never affected by the flag
    expect(mediaIssues({ media_type: "image", media_url: "https://cdn.example/x.png" }, ACCOUNT, { voiceNoteEnabled: false })).toEqual([]);
  });

  it("still requires a file", () => {
    expect(mediaIssues({ media_type: "audio", media_url: "" }).some((i) => i.field === "media_url")).toBe(true);
  });

  it("leaves image/video/document rules untouched", () => {
    for (const media_type of ["image", "video", "document"]) {
      expect(mediaIssues({ media_type, media_url: "https://cdn.example/x", caption: "ok", filename: "x.pdf" })).toEqual([]);
    }
    expect(mediaIssues({ media_type: "gif", media_url: "https://cdn.example/x" }).some((i) => i.field === "media_type")).toBe(true);
  });
});

describe("validateFlowForActivation — Multimedia audio scope is separate from Audios por producto", () => {
  it("lets a Multimedia audio through when only the Multimedia scope is on", () => {
    expect(mediaIssues(audio(), ACCOUNT, { voiceNoteEnabled: false, mediaAudioEnabled: true })).toEqual([]);
  });

  it("still blocks it when the Multimedia scope is off, and falls back to voiceNoteEnabled when it is not given", () => {
    expect(mediaIssues(audio(), ACCOUNT, { voiceNoteEnabled: true, mediaAudioEnabled: false }).some((i) => i.field === "media_type")).toBe(true);
    expect(mediaIssues(audio(), ACCOUNT, { voiceNoteEnabled: false }).some((i) => i.field === "media_type")).toBe(true);
  });

  it("keeps rejecting another account's file even when the scope is on for everyone", () => {
    const issues = mediaIssues(audio({ media_url: url(OTHER) }), ACCOUNT, { mediaAudioEnabled: true });
    expect(issues.some((i) => i.field === "media_url")).toBe(true);
  });
});
