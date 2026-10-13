import { afterEach, describe, expect, it } from "vitest";
import { CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV, REFERENCE_VARS_KEY, isCustomerActivityConfig, isCustomerReplyConditionEnabledForAccount, parseSendReference, referencedSendKeys, withSendReference } from "./customer-reply-condition";
import { validateFlowForActivation } from "./validate";
import { inspectDowngradeCompatibility } from "./downgrade-compatibility";

const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222"; const M = "33333333-3333-4333-8333-333333333333"; const C = "44444444-4444-4444-8444-444444444444";
const ref = { message_id: M, conversation_id: C, sent_at: "2026-10-14T10:00:00.123456+00:00" };
afterEach(() => { delete process.env[CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV]; });

describe("account gate", () => {
  it("is closed by default and only opens for a listed, valid UUID (case-insensitive); junk, wildcards and emails never open it", () => {
    expect(isCustomerReplyConditionEnabledForAccount(A)).toBe(false);
    process.env[CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV] = `${A.toUpperCase()}, not-a-uuid, *, owner@example.test, true`;
    expect(isCustomerReplyConditionEnabledForAccount(A)).toBe(true); expect(isCustomerReplyConditionEnabledForAccount(B)).toBe(false);
    for (const junk of ["*", "true", "owner@example.test", "", ",,"]) { process.env[CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV] = junk; expect(isCustomerReplyConditionEnabledForAccount(A)).toBe(false); }
  });
});

describe("send reference stored in the run", () => {
  it("round-trips, keeps the FIRST send of a node, and does not disturb other vars", () => {
    const vars = withSendReference({ name: "Ana" }, "info", ref);
    expect(vars.name).toBe("Ana"); expect(parseSendReference(vars, "info")).toEqual(ref);
    const again = withSendReference(vars, "info", { ...ref, message_id: B, sent_at: "2027-01-01T00:00:00Z" });
    expect(again).toBe(vars); expect(parseSendReference(again, "info")?.message_id).toBe(M);       // a loop never moves the reference forward
    expect(parseSendReference(withSendReference(vars, "other", { ...ref, message_id: B }), "info")?.message_id).toBe(M);
  });
  it.each([[{}], [{ [REFERENCE_VARS_KEY]: "x" }], [{ [REFERENCE_VARS_KEY]: [] }], [{ [REFERENCE_VARS_KEY]: { info: null } }], [{ [REFERENCE_VARS_KEY]: { info: { message_id: "nope", conversation_id: C, sent_at: ref.sent_at } } }],
    [{ [REFERENCE_VARS_KEY]: { info: { message_id: M, conversation_id: 5, sent_at: ref.sent_at } } }], [{ [REFERENCE_VARS_KEY]: { info: { message_id: M, conversation_id: C, sent_at: "yesterday-ish" } } }]])("a missing or corrupt reference parses to null (the engine then fails closed): %j", (vars) => {
    expect(parseSendReference(vars as Record<string, unknown>, "info")).toBeNull();
  });
  it("finds only the nodes that some customer-activity condition points at", () => {
    const keys = referencedSendKeys([{ node_type: "send_message", config: {} }, { node_type: "condition", config: { subject: "var", subject_key: "x" } }, { node_type: "condition", config: { subject: "customer_activity", subject_key: "info" } }, { node_type: "condition", config: { subject: "customer_activity", subject_key: "" } }]);
    expect([...keys]).toEqual(["info"]); expect(isCustomerActivityConfig({ subject: "customer_activity" })).toBe(true); expect(isCustomerActivityConfig({ subject: "tag" })).toBe(false); expect(isCustomerActivityConfig(null)).toBe(false);
  });
});

describe("validator", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
  const graph = (cond: Record<string, unknown>, refType = "send_message") => [
    { node_key: "start", node_type: "start", config: { next_node_key: "info" } }, { node_key: "info", node_type: refType, config: refType === "send_message" ? { text: "hola", next_node_key: "c" } : { media_type: "image", media_url: "https://x.test/a.jpg", next_node_key: "c" } },
    { node_key: "c", node_type: "condition", config: { subject: "customer_activity", subject_key: "info", operator: "replied_after_reference", true_next: "end", false_next: "end", ...cond } }, { node_key: "end", node_type: "end", config: {} }];
  const errors = (nodes: ReturnType<typeof graph>, options = {}) => validateFlowForActivation(flow, nodes, options).filter((i) => i.severity === "error");
  it("a well formed condition is only blocked by the execution gate (drafts can hold it; activation is refused)", () => {
    expect(errors(graph({}), { durableWaitExecution: true })).toEqual([]);
    expect(errors(graph({})).map((i) => i.field)).toEqual(["subject"]);
  });
  it("requires an explicit reference that is a send node of this flow, and the dedicated operator", () => {
    const opts = { durableWaitExecution: true };
    expect(errors(graph({ subject_key: "" }), opts).map((i) => i.field)).toContain("subject_key");
    expect(errors(graph({ subject_key: "ghost" }), opts).map((i) => i.field)).toContain("subject_key");
    expect(errors(graph({ subject_key: "end" }), opts).map((i) => i.field)).toContain("subject_key");
    expect(errors(graph({ operator: "present" }), opts).map((i) => i.field)).toContain("operator");
    expect(errors(graph({}, "send_media"), opts)).toEqual([]);
  });
  it("existing condition subjects keep their rules (no regression)", () => {
    const nodes = [{ node_key: "start", node_type: "start", config: { next_node_key: "c" } }, { node_key: "c", node_type: "condition", config: { subject: "var", subject_key: "x", operator: "present", true_next: "end", false_next: "end" } }, { node_key: "end", node_type: "end", config: {} }];
    expect(errors(nodes as ReturnType<typeof graph>)).toEqual([]);
    nodes[1].config.operator = "replied_after_reference";
    expect(errors(nodes as ReturnType<typeof graph>).map((i) => i.field)).toContain("operator");     // the new operator is not valid for other subjects
  });
});

describe("downgrade report", () => {
  it("lists flows holding the condition", () => {
    const report = inspectDowngradeCompatibility({ flows: [{ id: "f", status: "draft" }], nodes: [{ flow_id: "f", node_type: "condition", config: { subject: "customer_activity", subject_key: "info" } }], runs: [] });
    expect(report.result).toBe("BLOCKED_BY_CUSTOMER_REPLY_CONDITIONS"); expect(report.customer_reply_condition_flow_ids).toEqual(["f"]);
  });
});
