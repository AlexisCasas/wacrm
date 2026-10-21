import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), getCurrentAccount: vi.fn(), promote: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 403 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ marker: "admin" }) }));
vi.mock("@/lib/audio-guide/voice-note-store", () => ({ promoteVoiceNote: mocks.promote }));

import { GET, POST } from "./route";

const A = "046ff8c2-1111-4222-8333-444455556666";
const post = (body: unknown) =>
  POST(new Request("http://x/api/flows/voice-notes", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({ accountId: A });
  mocks.getCurrentAccount.mockResolvedValue({ accountId: A });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/flows/voice-notes", () => {
  it("GET reports disabled by default and enabled for a listed account, never caching", async () => {
    delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    const off = await GET();
    expect(await off.json()).toEqual({ enabled: false });
    expect(off.headers.get("Cache-Control")).toContain("no-store");
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it("POST is refused with 403 when the account is not enabled, before touching storage", async () => {
    delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    const res = await post({ path: `account-${A}/voice-staging/x.ogg` });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "voice_notes_disabled" });
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("POST promotes for an enabled account using the SESSION's account, never one from the body", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
    mocks.promote.mockResolvedValue({ ok: true, url: "https://s/u.ogg", sha256: "a".repeat(64), bytes: 10, durationMs: 2000, objectPath: "p" });
    const res = await post({ path: `account-${A}/voice-staging/x.ogg`, accountId: "99999999-aaaa-4bbb-8ccc-dddddddddddd" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://s/u.ogg", sha256: "a".repeat(64), bytes: 10, duration_ms: 2000 });
    expect(mocks.promote).toHaveBeenCalledWith({ admin: { marker: "admin" }, accountId: A, stagingPath: `account-${A}/voice-staging/x.ogg` });
  });

  it.each([
    [{ ok: false, code: "invalid_path" }, 400, { error: "invalid_path" }],
    [{ ok: false, code: "not_found" }, 404, { error: "file_not_found" }],
    [{ ok: false, code: "rejected", reason: "not_mono" }, 422, { error: "voice_note_rejected", reason: "not_mono" }],
    [{ ok: false, code: "storage_error" }, 502, { error: "storage_error" }],
  ])("maps %j to HTTP %i", async (result, status, body) => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
    mocks.promote.mockResolvedValue(result);
    const res = await post({ path: "x" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it("POST requires at least the agent role", async () => {
    mocks.requireRole.mockRejectedValue(new Error("Forbidden"));
    expect((await post({ path: "x" })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith("agent");
  });
});

describe("/api/flows/voice-notes with FLOW_MEDIA_AUDIO_SCOPE=all", () => {
  it("offers and accepts Multimedia audio to an account that is not in the list", async () => {
    delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    expect(await (await GET()).json()).toEqual({ enabled: true });
    mocks.promote.mockResolvedValue({ ok: true, url: "https://s/u.ogg", sha256: "a".repeat(64), bytes: 10, durationMs: 2000, objectPath: "p" });
    const res = await post({ path: `account-${A}/voice-staging/x.ogg` });
    expect(res.status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith({ admin: { marker: "admin" }, accountId: A, stagingPath: `account-${A}/voice-staging/x.ogg` });
  });
});
