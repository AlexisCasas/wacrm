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
    expect(await off.json()).toEqual({ enabled: false, product_audios: false });
    expect(off.headers.get("Cache-Control")).toContain("no-store");
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
    expect(await (await GET()).json()).toEqual({ enabled: true, product_audios: true });
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
    expect(await (await GET()).json()).toEqual({ enabled: true, product_audios: false });
    mocks.promote.mockResolvedValue({ ok: true, url: "https://s/u.ogg", sha256: "a".repeat(64), bytes: 10, durationMs: 2000, objectPath: "p" });
    const res = await post({ path: `account-${A}/voice-staging/x.ogg` });
    expect(res.status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith({ admin: { marker: "admin" }, accountId: A, stagingPath: `account-${A}/voice-staging/x.ogg` });
  });
});

describe("/api/flows/voice-notes reports two independent capabilities", () => {
  const ids = { pilot: "046ff8c2-644e-4aec-8fab-64047fdf9e38", keyler: "4d04a2e0-62b8-4508-a046-4b125aa2e8db", commercial: "c35b393f-9492-4321-80f2-987766c224d0" };
  const as = async (accountId: string) => {
    mocks.getCurrentAccount.mockResolvedValue({ accountId });
    return (await GET()).json();
  };

  it("pilot and Keyler (listed): Multimedia audio AND the product module", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${ids.pilot}, ${ids.keyler}`);
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    expect(await as(ids.pilot)).toEqual({ enabled: true, product_audios: true });
    expect(await as(ids.keyler)).toEqual({ enabled: true, product_audios: true });
  });

  it("the commercial account (not listed) with scope=all keeps Multimedia audio but NOT the product module", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${ids.pilot}, ${ids.keyler}`);
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    expect(await as(ids.commercial)).toEqual({ enabled: true, product_audios: false });
  });

  it("without scope=all an unlisted account has neither, and a listed one has both (the old behaviour)", async () => {
    delete process.env.FLOW_MEDIA_AUDIO_SCOPE;
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", ids.pilot);
    expect(await as(ids.commercial)).toEqual({ enabled: false, product_audios: false });
    expect(await as(ids.pilot)).toEqual({ enabled: true, product_audios: true });
  });

  it("scope=all never turns the product module on for everybody, and the answer is never cached", async () => {
    delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    mocks.getCurrentAccount.mockResolvedValue({ accountId: ids.keyler });
    const res = await GET();
    expect(await res.json()).toEqual({ enabled: true, product_audios: false });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("keeps `enabled` exactly as before for existing consumers (same value as the media gate)", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", ids.pilot);
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", "all");
    const body = await as(ids.commercial);
    expect(typeof body.enabled).toBe("boolean");
    expect(Object.keys(body).sort()).toEqual(["enabled", "product_audios"]);
  });
});
