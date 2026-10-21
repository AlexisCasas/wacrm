import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ marker: "admin" }) }));
vi.mock("@/lib/audio-guide/sender", () => ({ sendVoiceNoteViaEngine: vi.fn() }));
vi.mock("@/lib/audio-guide/sequencer", async (orig) => ({ ...(await orig<Record<string, unknown>>()), resumeAudioRequests: mocks.resume }));

import { GET, POST, maxDuration } from "./route";

const SECRET = "s3cret-value-that-is-long-enough-1234";
const post = (secret?: string, body?: unknown, url = "http://x/api/audio-guide/cron") =>
  POST(new Request(url, { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret }, body: body === undefined ? undefined : JSON.stringify(body) }));

beforeEach(() => { mocks.resume.mockReset().mockResolvedValue({ examined: 2, completed: 1 }); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/audio-guide/cron", () => {
  it("is not configured without a secret, or with one that is too short (503), and never runs", async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await post("x")).status).toBe(503);
    vi.stubEnv("AUTOMATION_CRON_SECRET", "short-secret");
    expect((await post("short-secret")).status).toBe(503);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("refuses a missing or wrong secret (401), of any length, without running", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    for (const bad of [undefined, "", SECRET.slice(0, -1) + "X", "short", SECRET + "-more"]) expect((await post(bad)).status).toBe(401);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("refuses a secret in the URL outright (400), even a correct one, so it can never reach a log", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    for (const name of ["secret", "token", "key", "cron_secret", "api_key"]) {
      const res = await post(SECRET, undefined, `http://x/api/audio-guide/cron?${name}=${SECRET}`);
      expect([res.status, await res.json()]).toEqual([400, { error: "secret_in_url_refused" }]);
    }
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("with the header secret it resumes, bounded: default 20 requests, a requested limit clamped to 1..50, a 50 s budget", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    const res = await post(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ examined: 2, completed: 1, duration_ms: expect.any(Number) });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const first = mocks.resume.mock.calls[0][0];
    expect(first).toMatchObject({ limit: 20, budgetMs: 50_000 });
    expect(first.isEnabled("046ff8c2-1111-4222-8333-444455556666")).toBe(false); // off unless FLOW_VOICE_NOTE_ACCOUNT_IDS lists the account
    for (const [asked, got] of [[5, 5], [0, 1], [500, 50], [2.5, 20], ["9", 20]] as const) {
      mocks.resume.mockClear();
      await post(SECRET, { limit: asked });
      expect(mocks.resume.mock.calls[0][0].limit).toBe(got);
    }
    expect(maxDuration).toBe(60);
  });
  it("logs one structured line of counts only, never the secret", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await post(SECRET);
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: "audio_guide_resume", examined: 2 });
    expect(line).not.toContain(SECRET);
  });
  it("a failure is a generic 500 that leaks nothing, and the secret is not logged", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.resume.mockRejectedValue(new Error(`postgres://user:pass@host/db exploded; x-cron-secret=${SECRET}`));
    const res = await post(SECRET);
    expect([res.status, await res.json()]).toEqual([500, { error: "resume_failed" }]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET);
  });
});

describe("GET /api/audio-guide/cron", () => {
  it("never runs anything: 405 with Allow: POST, whatever the credentials", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});
