import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ account: vi.fn(), exec: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ getCurrentAccount: mocks.account, toErrorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 403 }) }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/flows/execution-gates", () => ({ executionAllowedForAccount: mocks.exec }));
import { GET } from "./route";

const KEYLER = "11111111-1111-4111-8111-111111111111"; const ROSSY = "22222222-2222-4222-8222-222222222222"; const THIRD = "33333333-3333-4333-8333-333333333333"; const NEW_CO = "44444444-4444-4444-8444-444444444444";
const KEYS = ["FLOW_AUTHORING_SCOPE", "FLOW_EXECUTION_SCOPE", "FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS", "FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS", "FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS", "FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS"];
const caps = async (accountId: string) => { mocks.account.mockResolvedValue({ accountId }); const res = await GET(); expect(res.headers.get("Cache-Control")).toContain("no-store"); return res.json(); };
beforeEach(() => { for (const k of KEYS) delete process.env[k]; mocks.exec.mockReset(); mocks.exec.mockResolvedValue(false); });
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("GET /api/flows/capabilities", () => {
  it("today's production setting: only the account on the historic lists gets the authoring features; nothing can run", async () => {
    process.env.FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS = KEYLER; process.env.FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS = KEYLER; process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = KEYLER;
    expect(await caps(KEYLER)).toEqual({ customConditions: false, compoundConditions: false, subflowAuthoring: true, durableWaitAuthoring: true, customerReplyCondition: true, subflowExecution: false, durableWaitExecution: false });
    expect(await caps(ROSSY)).toMatchObject({ subflowAuthoring: false, durableWaitAuthoring: false, customerReplyCondition: false });
  });
  it("FLOW_AUTHORING_SCOPE=all: Keyler, Rossy, a third company and a company created later all get every authoring feature; F04 stays off", async () => {
    process.env.FLOW_AUTHORING_SCOPE = "all";
    for (const id of [KEYLER, ROSSY, THIRD, NEW_CO]) expect(await caps(id)).toMatchObject({ customConditions: false, subflowAuthoring: true, durableWaitAuthoring: true, customerReplyCondition: true, subflowExecution: false, durableWaitExecution: false });
  });
  it("what an account can RUN comes from the server (environment AND database) per account, never from the browser", async () => {
    process.env.FLOW_AUTHORING_SCOPE = "all"; mocks.exec.mockImplementation(async (_db: unknown, id: string, kind: string) => id === KEYLER && kind === "subflow");
    expect(await caps(KEYLER)).toMatchObject({ subflowExecution: true, durableWaitExecution: false }); expect(await caps(ROSSY)).toMatchObject({ subflowExecution: false, durableWaitExecution: false });
    expect(mocks.exec).toHaveBeenCalledWith(expect.anything(), KEYLER, "subflow"); expect(mocks.exec).toHaveBeenCalledWith(expect.anything(), KEYLER, "durable_wait");
  });
  it("a failed database read means 'cannot run', not an error page; an unauthenticated caller is refused", async () => {
    mocks.exec.mockRejectedValue(new Error("db down")); expect(await caps(KEYLER)).toMatchObject({ subflowExecution: false, durableWaitExecution: false });
    mocks.account.mockRejectedValue(new Error("no session")); expect((await GET()).status).toBe(403);
  });
});
