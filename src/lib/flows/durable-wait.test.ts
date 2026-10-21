import { afterEach, describe, expect, it } from "vitest";
import { computeResumeAt, durableWaitSeconds, isDurableWaitConfig, maxAmountFor, MAX_WAIT_SECONDS } from "./durable-wait";
import { DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV, DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV, durableWaitExecutionAccountIds, isDurableWaitAuthoringEnabledForAccount, isDurableWaitExecutionEnabledForAccount } from "./durable-wait-capability";
import { validateFlowForActivation } from "./validate";

describe("durableWaitSeconds", () => {
  it("converts seconds, minutes, hours and days (the 13-minute case = 780 s)", () => {
    expect(durableWaitSeconds({ amount: 13, unit: "minutes" })).toEqual({ ok: true, seconds: 780 });
    expect(durableWaitSeconds({ amount: 45, unit: "seconds" })).toEqual({ ok: true, seconds: 45 });
    expect(durableWaitSeconds({ amount: 2, unit: "hours" })).toEqual({ ok: true, seconds: 7200 });
    expect(durableWaitSeconds({ amount: 3, unit: "days" })).toEqual({ ok: true, seconds: 259200 });
  });
  it("accepts exactly 30 days and refuses anything longer, in any unit", () => {
    expect(durableWaitSeconds({ amount: 30, unit: "days" })).toEqual({ ok: true, seconds: MAX_WAIT_SECONDS });
    for (const bad of [{ amount: 31, unit: "days" }, { amount: 721, unit: "hours" }, { amount: 43201, unit: "minutes" }, { amount: 2592001, unit: "seconds" }]) expect(durableWaitSeconds(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "too_long" });
  });
  it("refuses unknown units and non-whole / non-positive / non-numeric amounts", () => {
    expect(durableWaitSeconds({ amount: 5, unit: "weeks" })).toEqual({ ok: false, reason: "invalid_unit" }); expect(durableWaitSeconds({ amount: 5 })).toEqual({ ok: false, reason: "invalid_unit" });
    for (const amount of [0, -1, 1.5, "5", null, undefined, NaN, Infinity]) expect(durableWaitSeconds({ amount, unit: "minutes" }), String(amount)).toEqual({ ok: false, reason: "invalid_amount" });
  });
  it("tells durable waits from legacy delays and bounds the editor input per unit", () => {
    expect(isDurableWaitConfig({ amount: 1, unit: "minutes" })).toBe(true); expect(isDurableWaitConfig({ seconds: 5 })).toBe(false); expect(isDurableWaitConfig(null)).toBe(false);
    expect([maxAmountFor("seconds"), maxAmountFor("minutes"), maxAmountFor("hours"), maxAmountFor("days")]).toEqual([2592000, 43200, 720, 30]);
  });
  it("computes the resume moment from the start", () => { expect(computeResumeAt(780, new Date("2026-10-14T10:00:00Z")).toISOString()).toBe("2026-10-14T10:13:00.000Z"); });
});

describe("per-account gates", () => {
  const pilot = "11111111-1111-4111-8111-111111111111"; const other = "22222222-2222-4222-8222-222222222222";
  const saved = [process.env[DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV], process.env[DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV]];
  afterEach(() => { for (const [i, k] of [DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV, DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV].entries()) { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; } });
  it("both are off for everyone by default and independent of each other", () => {
    delete process.env[DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV]; delete process.env[DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV];
    expect(isDurableWaitAuthoringEnabledForAccount(pilot)).toBe(false); expect(isDurableWaitExecutionEnabledForAccount(pilot)).toBe(false); expect(durableWaitExecutionAccountIds()).toEqual([]);
    process.env[DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV] = pilot;
    expect(isDurableWaitAuthoringEnabledForAccount(pilot)).toBe(true); expect(isDurableWaitAuthoringEnabledForAccount(other)).toBe(false); expect(isDurableWaitExecutionEnabledForAccount(pilot)).toBe(false);
  });
  it("never matches loosely (e-mail, prefixes, garbage)", () => {
    for (const v of ["someone@example.test", "11111111", `${pilot}x`, "*", "true", ",,"]) { process.env[DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV] = v; process.env[DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV] = v; expect(isDurableWaitAuthoringEnabledForAccount(pilot), v).toBe(false); expect(isDurableWaitExecutionEnabledForAccount(pilot), v).toBe(false); expect(durableWaitExecutionAccountIds(), v).toEqual([]); }
  });
});

describe("activation validator", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
  const nodes = (wait: Record<string, unknown>) => [{ node_key: "start", node_type: "start", config: { next_node_key: "w" } }, { node_key: "w", node_type: "delay", config: { ...wait, next_node_key: "end" } }, { node_key: "end", node_type: "end", config: {} }];
  const errors = (n: ReturnType<typeof nodes>, opts?: { durableWaitExecution?: boolean }) => validateFlowForActivation(flow, n, opts).filter((i) => i.severity === "error");
  it("a durable wait blocks activation unless execution is enabled (the default)", () => { expect(errors(nodes({ amount: 13, unit: "minutes" })).length).toBeGreaterThan(0); expect(errors(nodes({ amount: 13, unit: "minutes" }), { durableWaitExecution: false }).length).toBeGreaterThan(0); });
  it("with execution enabled a valid wait is accepted and an invalid one is not", () => {
    expect(errors(nodes({ amount: 13, unit: "minutes" }), { durableWaitExecution: true })).toEqual([]);
    expect(errors(nodes({ amount: 31, unit: "days" }), { durableWaitExecution: true }).length).toBe(1); expect(errors(nodes({ amount: 0, unit: "hours" }), { durableWaitExecution: true }).length).toBe(1);
  });
  it("the legacy 1-30 second delay is unchanged: valid <= 30 s, invalid above, whatever the options", () => {
    expect(errors(nodes({ seconds: 30 }))).toEqual([]); expect(errors(nodes({ seconds: 31 })).length).toBe(1); expect(errors(nodes({ seconds: 5 }), { durableWaitExecution: true })).toEqual([]);
  });
});
