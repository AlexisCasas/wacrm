import { afterEach, describe, expect, it } from "vitest";
import { isSubflowAuthoringEnabledForAccount, SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV } from "./subflow-authoring-capability";

const previous = process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV];
afterEach(() => { if (previous === undefined) delete process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV]; else process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = previous; });

describe("isSubflowAuthoringEnabledForAccount", () => {
  // the shape of the production pilot account id (v4 uuid), and two other accounts of the same installation shape
  const pilot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const otherB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  it("is off for everyone by default", () => { delete process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV]; for (const id of [pilot, otherA, otherB]) expect(isSubflowAuthoringEnabledForAccount(id)).toBe(false); });
  it("is on only for the listed account", () => {
    process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = ` ${pilot} `;
    expect(isSubflowAuthoringEnabledForAccount(pilot)).toBe(true);
    expect(isSubflowAuthoringEnabledForAccount(otherA)).toBe(false);
    expect(isSubflowAuthoringEnabledForAccount(otherB)).toBe(false);
  });
  it("never matches loosely: prefixes, e-mails, malformed ids and empty entries enable nothing", () => {
    for (const value of ["pilot.user@example.test", "aaaaaaaa", `${pilot}x`, ",,", "*", "true"]) {
      process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] = value;
      expect(isSubflowAuthoringEnabledForAccount(pilot), value).toBe(false);
    }
  });
});
