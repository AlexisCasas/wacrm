import { afterEach, describe, expect, it } from "vitest";
import { CUSTOM_CONDITION_ACCOUNT_IDS_ENV, isCustomConditionEnabledForAccount } from "./custom-condition-capability";

const previous = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV];
afterEach(() => { if (previous === undefined) delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]; else process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = previous; });

describe("isCustomConditionEnabledForAccount", () => {
  const accountA = "11111111-1111-4111-8111-111111111111";
  const accountB = "22222222-2222-4222-8222-222222222222";
  it("fails closed by default", () => { delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]; expect(isCustomConditionEnabledForAccount(accountA)).toBe(false); });
  it("allows only explicitly configured accounts", () => { process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = `${accountA}, ${accountB}`; expect(isCustomConditionEnabledForAccount(accountA)).toBe(true); expect(isCustomConditionEnabledForAccount("33333333-3333-4333-8333-333333333333")).toBe(false); });
  it("ignores malformed allowlist entries instead of enabling a loose string match", () => { process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = "account-a, 11111111-1111-4111-8111-111111111111x"; expect(isCustomConditionEnabledForAccount(accountA)).toBe(false); });
});
