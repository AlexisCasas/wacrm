import { afterEach, describe, expect, it } from "vitest";
import { isSubflowAuthoringEnabledForAccount, SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV } from "./subflow-authoring-capability";

const previous = process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV];
afterEach(() => { if (previous === undefined) delete process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV]; else process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = previous; });

describe("isSubflowAuthoringEnabledForAccount", () => {
  // the shape of the production pilot account id (v4 uuid), and two other accounts of the same installation shape
  const pilot = "11111111-1111-4111-8111-111111111111";
  const otherA = "22222222-2222-4222-8222-222222222222";
  const otherB = "33333333-3333-4333-8333-333333333333";
  it("is off for everyone by default", () => { delete process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV]; for (const id of [pilot, otherA, otherB]) expect(isSubflowAuthoringEnabledForAccount(id)).toBe(false); });
  it("is on only for the listed account", () => {
    process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = ` ${pilot} `;
    expect(isSubflowAuthoringEnabledForAccount(pilot)).toBe(true);
    expect(isSubflowAuthoringEnabledForAccount(otherA)).toBe(false);
    expect(isSubflowAuthoringEnabledForAccount(otherB)).toBe(false);
  });
  it("never matches loosely: prefixes, e-mails, malformed ids and empty entries enable nothing", () => {
    for (const value of ["someone@example.test", "11111111", `${pilot}x`, ",,", "*", "true"]) {
      process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = value;
      expect(isSubflowAuthoringEnabledForAccount(pilot), value).toBe(false);
    }
  });
});
