import { afterEach, describe, expect, it } from "vitest";
import { CUSTOM_CONDITION_ACCOUNT_IDS_ENV, isCustomConditionEnabledForAccount } from "./custom-condition-capability";

const previous = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV];
afterEach(() => { if (previous === undefined) delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]; else process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = previous; });

describe("isCustomConditionEnabledForAccount", () => {
  it("fails closed by default", () => { delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]; expect(isCustomConditionEnabledForAccount("account-a")).toBe(false); });
  it("allows only explicitly configured accounts", () => { process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = "account-a, account-b"; expect(isCustomConditionEnabledForAccount("account-a")).toBe(true); expect(isCustomConditionEnabledForAccount("account-c")).toBe(false); });
});
