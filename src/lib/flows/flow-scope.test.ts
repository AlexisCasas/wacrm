import { afterEach, describe, expect, it } from "vitest";
import { FLOW_AUTHORING_SCOPE_ENV, FLOW_EXECUTION_SCOPE_ENV, authoringAllowed, executionAllowed, readScope } from "./flow-scope";
import { isSubflowAuthoringEnabledForAccount } from "./subflow-authoring-capability";
import { isDurableWaitAuthoringEnabledForAccount, isDurableWaitExecutionEnabledForAccount, durableWaitExecutionAccountIds } from "./durable-wait-capability";
import { isCustomerReplyConditionEnabledForAccount } from "./customer-reply-condition";
import { isSubflowExecutionEnabledForAccount, subflowExecutionAccountIds } from "./subflow-execution-capability";
import { isCustomConditionEnabledForAccount } from "./custom-condition-capability";

const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222"; const NEW_COMPANY = "99999999-9999-4999-8999-999999999999";
const KEYS = [FLOW_AUTHORING_SCOPE_ENV, FLOW_EXECUTION_SCOPE_ENV, "FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS", "FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS", "FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS", "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS", "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS", "FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });
const authoring = (id: string) => [isSubflowAuthoringEnabledForAccount(id), isDurableWaitAuthoringEnabledForAccount(id), isCustomerReplyConditionEnabledForAccount(id)];
const execution = (id: string) => [isSubflowExecutionEnabledForAccount(id), isDurableWaitExecutionEnabledForAccount(id)];

describe("scope switches", () => {
  it("default = allowlist: nothing changes until an operator sets the switch (empty lists open nothing)", () => {
    expect(readScope(FLOW_AUTHORING_SCOPE_ENV)).toBe("allowlist"); expect(authoring(A)).toEqual([false, false, false]); expect(execution(A)).toEqual([false, false]);
    process.env.FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS = A; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = `${A}, junk`;
    expect(isSubflowAuthoringEnabledForAccount(A)).toBe(true); expect(isSubflowAuthoringEnabledForAccount(B)).toBe(false); expect(isDurableWaitExecutionEnabledForAccount(A)).toBe(true);
  });
  it("authoring = all opens the three P4-P8 authoring features for EVERY account, including one that registers later, without any list", () => {
    process.env[FLOW_AUTHORING_SCOPE_ENV] = "all";
    for (const id of [A, B, NEW_COMPANY]) expect(authoring(id)).toEqual([true, true, true]);
    expect(execution(A)).toEqual([false, false]);                                      // authoring says nothing about running
    expect(authoringAllowed("ANY", "")).toBe(false);                                   // an empty account id is never allowed
  });
  it("execution = all opens only the ENVIRONMENT half of the execution keys (the database is the other half) and tells the scheduler to ask the database", () => {
    process.env[FLOW_EXECUTION_SCOPE_ENV] = "all";
    for (const id of [A, B, NEW_COMPANY]) expect(execution(id)).toEqual([true, true]);
    expect(authoring(A)).toEqual([false, false, false]);
    expect(durableWaitExecutionAccountIds()).toBeNull(); expect(subflowExecutionAccountIds()).toBeNull();
  });
  it("off closes everything even when the historic lists name the account (kill switch)", () => {
    for (const k of KEYS.slice(2, 7)) process.env[k] = A; process.env[FLOW_AUTHORING_SCOPE_ENV] = "off"; process.env[FLOW_EXECUTION_SCOPE_ENV] = "off";
    expect(authoring(A)).toEqual([false, false, false]); expect(execution(A)).toEqual([false, false]); expect(durableWaitExecutionAccountIds()).toEqual([]); expect(subflowExecutionAccountIds()).toEqual([]);
  });
  it("a typo or any other value is OFF, never ON (fail closed); case and spaces are tolerated for the three real values", () => {
    for (const junk of ["true", "*", "yes", "1", "alll", "enabled"]) { process.env[FLOW_AUTHORING_SCOPE_ENV] = junk; expect(readScope(FLOW_AUTHORING_SCOPE_ENV)).toBe("off"); expect(authoring(A)).toEqual([false, false, false]); }
    process.env[FLOW_AUTHORING_SCOPE_ENV] = "  ALL "; expect(readScope(FLOW_AUTHORING_SCOPE_ENV)).toBe("all"); process.env[FLOW_AUTHORING_SCOPE_ENV] = "AllowList"; expect(readScope(FLOW_AUTHORING_SCOPE_ENV)).toBe("allowlist");
    process.env[FLOW_AUTHORING_SCOPE_ENV] = ""; expect(readScope(FLOW_AUTHORING_SCOPE_ENV)).toBe("allowlist");
  });
  it("the allowlist scheduler list is the listed valid ids; junk entries never count", () => {
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = `${A.toUpperCase()}, *, ${B}x, owner@example.test`; process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = B;
    expect(durableWaitExecutionAccountIds()).toEqual([A]); expect(subflowExecutionAccountIds()).toEqual([B]); expect(executionAllowed("FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS", A)).toBe(true);
  });
  it("experimental switches that do not belong to P4-P8 are NOT opened by the global scopes (F04 custom-field conditions)", () => {
    process.env[FLOW_AUTHORING_SCOPE_ENV] = "all"; process.env[FLOW_EXECUTION_SCOPE_ENV] = "all";
    expect(isCustomConditionEnabledForAccount(A)).toBe(false);
  });
});
