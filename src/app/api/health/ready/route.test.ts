import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ limit: () => mocks.query() }) }) }),
}));
import { GET } from "./route";

beforeEach(() => { mocks.query.mockReset(); });

describe("GET /api/health/ready", () => {
  it("200 ready when the database answers", async () => {
    mocks.query.mockResolvedValue({ data: [{ id: "a" }], error: null });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("503 when the database returns an error, without leaking it", async () => {
    mocks.query.mockResolvedValue({ data: null, error: { message: "password authentication failed for user hunter2" } });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"status":"not_ready"}');
    expect(body).not.toContain("hunter2");
  });

  it("503 when the client throws", async () => {
    mocks.query.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.5:5432"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.5");
  });

  it("503 when the database does not answer within the timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.query.mockReturnValue(new Promise(() => {}));
      const pending = GET();
      await vi.advanceTimersByTimeAsync(3_100);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});
