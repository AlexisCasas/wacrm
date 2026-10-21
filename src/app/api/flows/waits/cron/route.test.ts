import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("@/lib/flows/engine", () => ({ resumeDueFlowWaits: mocks.resume }));
import { GET } from "./route";

const PILOT = "11111111-1111-4111-8111-111111111111";
const call = (secret?: string, query = "") => GET(new Request(`http://localhost/api/flows/waits/cron${query}`, { headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
const saved = { secret: process.env.AUTOMATION_CRON_SECRET, exec: process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS };
beforeEach(() => { mocks.resume.mockReset(); mocks.resume.mockResolvedValue({ claimed: 2, resumed: 2, skipped: 0, lost: 0, failed: 0, budgetExhausted: false }); process.env.AUTOMATION_CRON_SECRET = "s3cret-for-tests"; delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS });
afterEach(() => { for (const [k, v] of [["AUTOMATION_CRON_SECRET", saved.secret], ["FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS", saved.exec]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("GET /api/flows/waits/cron", () => {
  it("is protected by the shared cron secret", async () => {
    expect((await call()).status).toBe(401); expect((await call("wrong")).status).toBe(401);
    delete process.env.AUTOMATION_CRON_SECRET; expect((await call("s3cret-for-tests")).status).toBe(503); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("does nothing, and touches no database, while execution is disabled for every account (production)", async () => {
    const response = await call("s3cret-for-tests"); expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: false, claimed: 0 }); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("passes only the enabled accounts and a bounded batch size to the engine", async () => {
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = `${PILOT}, not-an-id`;
    const body = await (await call("s3cret-for-tests", "?limit=9999")).json(); expect(body).toMatchObject({ enabled: true, resumed: 2 });
    expect(mocks.resume).toHaveBeenLastCalledWith({ accountIds: [PILOT], limit: 25 });           // out-of-range limit falls back to the default
    await call("s3cret-for-tests", "?limit=40"); expect(mocks.resume).toHaveBeenLastCalledWith({ accountIds: [PILOT], limit: 40 });
  });
  it("reports a failed pass without leaking details", async () => {
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = PILOT; mocks.resume.mockRejectedValue(new Error("db password is hunter2")); vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("s3cret-for-tests"); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });
});
