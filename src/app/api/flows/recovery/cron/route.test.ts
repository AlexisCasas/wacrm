import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock("@/lib/flows/engine", () => ({ recoverStrandedRuns: mocks.recover }));
import { GET } from "./route";

const PILOT = "11111111-1111-4111-8111-111111111111"; const OTHER = "22222222-2222-4222-8222-222222222222";
const call = (secret?: string) => GET(new Request("http://localhost/api/flows/recovery/cron", { headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
const KEYS = ["AUTOMATION_CRON_SECRET", "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS", "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } mocks.recover.mockReset(); mocks.recover.mockResolvedValue({ examined: 1, resumed: 1, ambiguous: 0, unsafe: 0, skipped: 0, failed: 0 }); process.env.AUTOMATION_CRON_SECRET = "s3cret-for-tests"; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("GET /api/flows/recovery/cron (prepared, not scheduled)", () => {
  it("is protected by the shared cron secret", async () => {
    expect((await call()).status).toBe(401); expect((await call("wrong")).status).toBe(401);
    delete process.env.AUTOMATION_CRON_SECRET; expect((await call("s3cret-for-tests")).status).toBe(503); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("does nothing and touches no database while no account has execution enabled (production today)", async () => {
    const response = await call("s3cret-for-tests"); expect(await response.json()).toEqual({ enabled: false, examined: 0 }); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("passes only the enabled accounts (waits or subflows), without duplicates", async () => {
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = `${PILOT}, junk`; process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = `${OTHER},${PILOT}`;
    expect(await (await call("s3cret-for-tests")).json()).toMatchObject({ enabled: true, resumed: 1 });
    expect(mocks.recover).toHaveBeenCalledWith({ accountIds: expect.arrayContaining([PILOT, OTHER]), limit: 25 }); expect(mocks.recover.mock.calls[0][0].accountIds).toHaveLength(2);
  });
  it("reports a failed pass without leaking details", async () => {
    process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = PILOT; mocks.recover.mockRejectedValue(new Error("db password is hunter2")); vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("s3cret-for-tests"); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });
});
