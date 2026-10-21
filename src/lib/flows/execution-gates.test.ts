import { afterEach, describe, expect, it } from "vitest";
import { executionAllowedForAccount, executionEnabledInDb, schedulerAccountIds } from "./execution-gates";

const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222";
const KEYS = ["FLOW_EXECUTION_SCOPE", "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS", "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });
const rpcDb = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }), from: () => { throw new Error("row table must not be read when the function answers"); } });
const rowDb = (row: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }) });

describe("database half of the execution keys", () => {
  it("uses flow_execution_enabled (account row, else global default) when it exists", async () => {
    expect(await executionEnabledInDb(rpcDb(true), A, "subflow")).toBe(true); expect(await executionEnabledInDb(rpcDb(false), A, "durable_wait")).toBe(false);
  });
  it("falls back to the per-account row on a database that only has migration 070, and fails closed on any error", async () => {
    expect(await executionEnabledInDb(rowDb({ subflow_execution: true }), A, "subflow")).toBe(true);
    expect(await executionEnabledInDb(rowDb({ durable_wait_execution: false }), A, "durable_wait")).toBe(false);
    expect(await executionEnabledInDb(rowDb(null), A, "subflow")).toBe(false);
    expect(await executionEnabledInDb(rowDb(null, { message: "boom" }), A, "subflow")).toBe(false);
    expect(await executionEnabledInDb({ rpc: async () => { throw new Error("x"); }, from: () => { throw new Error("y"); } }, A, "subflow")).toBe(false);
  });
  it("BOTH keys are required: environment scope and database", async () => {
    expect(await executionAllowedForAccount(rpcDb(true), A, "subflow")).toBe(false);                    // database yes, environment no (default allowlist, empty)
    process.env.FLOW_EXECUTION_SCOPE = "all"; expect(await executionAllowedForAccount(rpcDb(true), A, "subflow")).toBe(true);
    expect(await executionAllowedForAccount(rpcDb(false), A, "subflow")).toBe(false);                   // environment yes, database no
    process.env.FLOW_EXECUTION_SCOPE = "off"; expect(await executionAllowedForAccount(rpcDb(true), A, "subflow")).toBe(false);
  });
});

describe("accounts a scheduler pass may serve", () => {
  const never = () => { throw new Error("no database call expected"); };
  it("default or off: nobody, and the database is never touched", async () => {
    expect(await schedulerAccountIds(never as never, ["durable_wait", "subflow"])).toEqual([]);
    process.env.FLOW_EXECUTION_SCOPE = "off"; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = A; expect(await schedulerAccountIds(never as never, ["durable_wait"])).toEqual([]);
  });
  it("allowlist: the listed accounts without a database call", async () => {
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = A; process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = `${A},${B}`;
    expect((await schedulerAccountIds(never as never, ["durable_wait", "subflow"])).sort()).toEqual([A, B].sort());
  });
  it("all: whatever the database says is enabled, per kind, without duplicates; a failing read is an error (the pass does not run blind)", async () => {
    process.env.FLOW_EXECUTION_SCOPE = "all"; const asked: string[] = [];
    const db = { rpc: async (_fn: string, args: { p_kind: string }) => { asked.push(args.p_kind); return { data: args.p_kind === "subflow" ? [A, B] : [A], error: null }; } };
    expect((await schedulerAccountIds(() => db as never, ["durable_wait", "subflow"])).sort()).toEqual([A, B].sort()); expect(asked).toEqual(["durable_wait", "subflow"]);
    await expect(schedulerAccountIds(() => ({ rpc: async () => ({ data: null, error: { message: "down" } }) }) as never, ["subflow"])).rejects.toThrow(/enabled_execution_account_ids failed/);
  });
});
