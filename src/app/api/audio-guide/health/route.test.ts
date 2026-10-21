import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ marker: "admin" }) }));
vi.mock("@/lib/audio-guide/health", () => ({ readAudioGuideHealth: mocks.health }));

import { GET } from "./route";

const SECRET = "s3cret-value-that-is-long-enough-1234";
const get = (secret?: string, url = "http://x/api/audio-guide/health") => GET(new Request(url, { headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
const ok = { status: "ok", checks: { stuckRequests: 0, dueBacklog: 0, uncertainSends24h: 1, incompleteRequests24h: 2 }, thresholds: { stuckMinutes: 10, backlogMinutes: 5 } };

beforeEach(() => { mocks.health.mockReset().mockResolvedValue(ok); vi.spyOn(console, "error").mockImplementation(() => {}); vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET); });
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/audio-guide/health", () => {
  it("needs the header secret: 401 without it, 400 in the URL, 503 when not configured", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("wrong-secret-wrong-secret-wrong")).status).toBe(401);
    expect((await get(SECRET, `http://x/api/audio-guide/health?secret=${SECRET}`)).status).toBe(400);
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await get(SECRET)).status).toBe(503);
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it("200 when healthy, 503 when degraded (a monitor can page on the status code), counts only", async () => {
    const good = await get(SECRET);
    expect([good.status, await good.json()]).toEqual([200, ok]);
    mocks.health.mockResolvedValue({ ...ok, status: "degraded", checks: { ...ok.checks, stuckRequests: 3 } });
    expect((await get(SECRET)).status).toBe(503);
  });
  it("a failing read is a 500 'unknown', never reported as healthy", async () => {
    mocks.health.mockRejectedValue(new Error("db down"));
    const res = await get(SECRET);
    expect([res.status, (await res.json()).status]).toEqual([500, "unknown"]);
  });
});
