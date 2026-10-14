import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resume: vi.fn(), recover: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/flows/engine", () => ({ resumeDueFlowWaits: mocks.resume, recoverStrandedRuns: mocks.recover }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { GET as waits } from "./route";
import { GET as recovery } from "../../recovery/cron/route";

const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222";
const KEYS = ["AUTOMATION_CRON_SECRET", "FLOW_EXECUTION_SCOPE", "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS", "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS"];
const call = (handler: (request: Request) => Promise<Response>, secret = "s3cret-for-tests") => handler(new Request("http://localhost/x", { headers: { "x-cron-secret": secret } }));
beforeEach(() => { for (const k of KEYS) delete process.env[k]; process.env.AUTOMATION_CRON_SECRET = "s3cret-for-tests"; for (const m of Object.values(mocks)) m.mockReset();
  mocks.resume.mockResolvedValue({ claimed: 0, resumed: 0, skipped: 0, lost: 0, failed: 0, budgetExhausted: false }); mocks.recover.mockResolvedValue({ examined: 0, resumed: 0, ambiguous: 0, unsafe: 0, skipped: 0, failed: 0 });
  mocks.rpc.mockImplementation(async (_fn: string, args: { p_kind: string }) => ({ data: args.p_kind === "subflow" ? [A, B] : [A], error: null })); });
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("the scheduler endpoints under the global execution scope", () => {
  it("both stay silent, with zero database calls, while nothing is enabled (production today)", async () => {
    expect(await (await call(waits)).json()).toEqual({ enabled: false, claimed: 0 }); expect(await (await call(recovery)).json()).toEqual({ enabled: false, examined: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("with FLOW_EXECUTION_SCOPE=all they serve exactly the accounts the DATABASE has enabled, per kind", async () => {
    process.env.FLOW_EXECUTION_SCOPE = "all";
    await call(waits); expect(mocks.rpc).toHaveBeenCalledWith("enabled_execution_account_ids", { p_kind: "durable_wait" }); expect(mocks.resume).toHaveBeenCalledWith({ accountIds: [A], limit: 25 });
    await call(recovery); expect(mocks.recover).toHaveBeenCalledWith({ accountIds: expect.arrayContaining([A, B]), limit: 25 }); expect(mocks.recover.mock.calls[0][0].accountIds).toHaveLength(2);
  });
  it("nothing enabled in the database means no pass at all; an unreadable database is an error, never a blind pass; the secret is still required", async () => {
    process.env.FLOW_EXECUTION_SCOPE = "all"; mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await (await call(waits)).json()).toEqual({ enabled: false, claimed: 0 }); expect(mocks.resume).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } }); vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call(waits)).status).toBe(500); expect((await call(recovery)).status).toBe(500); expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
    expect((await call(waits, "wrong")).status).toBe(401); expect((await call(recovery, "wrong")).status).toBe(401);
  });
});
