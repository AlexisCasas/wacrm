import { afterEach, describe, expect, it } from "vitest";
import { SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV, SUBFLOW_MAX_DEPTH, isSubflowExecutionEnabledForAccount } from "./subflow-execution-capability";
import { analyzeCallGraph, isSubflowExecutionAllowed, type AccountFlowInfo } from "./subflow-activation";
import { classifyStrandedRun } from "./engine";
import { validateFlowForActivation } from "./validate";

const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222"; const C = "33333333-3333-4333-8333-333333333333";
afterEach(() => { delete process.env[SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV]; });

describe("environment gate", () => {
  it("is closed by default and only a listed valid UUID opens it (never a wildcard, email or word)", () => {
    expect(isSubflowExecutionEnabledForAccount(A)).toBe(false);
    process.env[SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV] = `${A.toUpperCase()}, nope`; expect(isSubflowExecutionEnabledForAccount(A)).toBe(true); expect(isSubflowExecutionEnabledForAccount(B)).toBe(false);
    for (const junk of ["*", "true", "owner@example.test", ",,"]) { process.env[SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV] = junk; expect(isSubflowExecutionEnabledForAccount(A)).toBe(false); }
  });
  it("execution needs BOTH the environment value and the backend table row; a failed read counts as no", async () => {
    const db = (row: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }) });
    expect(await isSubflowExecutionAllowed(db({ subflow_execution: true }), A)).toBe(false);                    // row but no environment flag
    process.env[SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV] = A;
    expect(await isSubflowExecutionAllowed(db(null), A)).toBe(false);                                           // flag but no row
    expect(await isSubflowExecutionAllowed(db({ subflow_execution: false }), A)).toBe(false);
    expect(await isSubflowExecutionAllowed(db(null, { message: "boom" }), A)).toBe(false);
    expect(await isSubflowExecutionAllowed(db({ subflow_execution: true }), A)).toBe(true);
  });
});

describe("call graph checks before activation", () => {
  const info = (status: string, targets: string[] = [], endScopes: Array<string | undefined> = ["subflow"]): AccountFlowInfo => ({ status, targets, endScopes });
  const mine = (...targets: string[]) => ({ status: "draft", targets, endScopes: [], callNodes: targets.map((target, i) => ({ node_key: `call${i}`, target })) });
  it("accepts active callees that return, and reports a missing, inactive or self target", () => {
    expect(analyzeCallGraph(A, mine(B, C), new Map([[B, info("active")], [C, info("active")]]))).toEqual([]);
    expect(analyzeCallGraph(A, mine(B), new Map()).map((i) => i.code)).toEqual(["target_not_found"]);
    expect(analyzeCallGraph(A, mine(B), new Map([[B, info("draft")]])).map((i) => i.code)).toEqual(["target_not_active"]);
    expect(analyzeCallGraph(A, mine(A), new Map()).map((i) => i.code)).toEqual(["cycle"]);
  });
  it("detects loops through other flows and nesting deeper than the limit", () => {
    expect(analyzeCallGraph(A, mine(B), new Map([[B, info("active", [A])]])).map((i) => i.code)).toContain("cycle");
    const D = "44444444-4444-4444-8444-444444444444"; const E = "55555555-5555-4555-8555-555555555555";
    const chain = new Map([[B, info("active", [C])], [C, info("active", [D])], [D, info("active", [E])], [E, info("active")]]);
    expect(SUBFLOW_MAX_DEPTH).toBe(3); expect(analyzeCallGraph(A, mine(B), chain).map((i) => i.code)).toContain("too_deep");
    const ok = new Map([[B, info("active", [C])], [C, info("active", [D])], [D, info("active")]]); expect(analyzeCallGraph(A, mine(B), ok).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("warns when the called flow never gives control back (every End ends the whole execution)", () => {
    const issues = analyzeCallGraph(A, mine(B), new Map([[B, info("active", [], [undefined, "run"])]]));
    expect(issues).toHaveLength(1); expect(issues[0]).toMatchObject({ severity: "warning", code: "callee_never_returns" });
    expect(analyzeCallGraph(A, mine(B), new Map([[B, info("active", [], [undefined, "subflow"])]]))).toEqual([]);
  });
});

describe("stranded run classification", () => {
  const ev = (event_type: string, reason?: string, node_key = "follow") => ({ event_type, node_key, payload: reason ? { reason } : {}, created_at: "2026-10-14T10:00:00Z" });
  it("no send evidence after the cursor: recoverable", () => { expect(classifyStrandedRun([])).toEqual({ kind: "recoverable" }); expect(classifyStrandedRun([ev("node_entered", "stranded_run_resumed")])).toEqual({ kind: "recoverable" }); });
  it("an intent without its confirmation: ambiguous, never resent", () => {
    expect(classifyStrandedRun([ev("node_entered", "send_intent")])).toEqual({ kind: "ambiguous", nodeKey: "follow" });
    expect(classifyStrandedRun([ev("node_entered", "send_intent"), ev("message_sent"), ev("node_entered", "send_intent", "next")])).toEqual({ kind: "ambiguous", nodeKey: "next" });
  });
  it("a confirmed send after the cursor: the in-memory progress is unknown, not replayed", () => { expect(classifyStrandedRun([ev("node_entered", "send_intent"), ev("message_sent")])).toEqual({ kind: "unsafe" }); });
});

describe("validator", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
  const nodes = (call: Record<string, unknown>, end: Record<string, unknown> = {}) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "info" } }, { node_key: "info", node_type: "send_message", config: { text: "hola", next_node_key: "call" } },
    { node_key: "call", node_type: "execute_flow", config: { target_flow_id: B, next_node_key: "end", ...call } }, { node_key: "end", node_type: "end", config: end }];
  const errors = (n: ReturnType<typeof nodes>, options = {}) => validateFlowForActivation(flow, n, options).filter((i) => i.severity === "error");
  it("execute_flow stays refused unless the account may run subflows (P4/P6 behaviour untouched)", () => {
    expect(errors(nodes({})).map((i) => i.node_key)).toContain("call");
    expect(errors(nodes({}), { subflowExecution: true })).toEqual([]);
  });
  it("checks the reference step and the reply policy of a call", () => {
    const o = { subflowExecution: true };
    expect(errors(nodes({ reference_node_key: "info", on_customer_reply: "continue" }), o)).toEqual([]);
    expect(errors(nodes({ reference_node_key: "end" }), o).map((i) => i.field)).toContain("reference_node_key");
    expect(errors(nodes({ reference_node_key: "ghost" }), o).map((i) => i.field)).toContain("reference_node_key");
    expect(errors(nodes({ on_customer_reply: "maybe" }), o).map((i) => i.field)).toContain("on_customer_reply");
  });
  it("accepts the End scope values only; the default (no scope) is unchanged", () => {
    const o = { subflowExecution: true };
    expect(errors(nodes({}, { scope: "subflow" }), o)).toEqual([]); expect(errors(nodes({}, { scope: "run" }), o)).toEqual([]); expect(errors(nodes({}), o)).toEqual([]);
    expect(errors(nodes({}, { scope: "everything" }), o).map((i) => i.field)).toContain("scope");
  });
  it("a customer-activity condition may use the reference inherited from the calling flow", () => {
    const n = [{ node_key: "start", node_type: "start", config: { next_node_key: "c" } }, { node_key: "c", node_type: "condition", config: { subject: "customer_activity", subject_key: "$inherited", operator: "replied_after_reference", true_next: "end", false_next: "end" } }, { node_key: "end", node_type: "end", config: { scope: "subflow" } }];
    expect(errors(n as ReturnType<typeof nodes>, { durableWaitExecution: true })).toEqual([]);
  });
});
