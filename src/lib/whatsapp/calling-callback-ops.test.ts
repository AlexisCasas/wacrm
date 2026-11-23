import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import callbackOps from "../../../scripts/ops/calling-callback-permission-inkaclick.cjs";

const ops = callbackOps as {
  PHONE_NUMBER_ID: string;
  safeCallingSettings: (response: unknown) => Record<string, string>;
  assertSafeCallingMode: (response: Record<string, string>) => void;
  callbackPayload: (enabled: boolean) => unknown;
  unchangedCallingFields: (response: { calling: Record<string, unknown> }) => string;
  decryptToken: (encrypted: string, key: string) => string;
};

const baseline = {
  calling: {
    status: "ENABLED",
    callback_permission_status: "DISABLED",
    call_permission_mode: "ALLOW_APPROVED_PERMISSION_ONLY",
    sip: { status: "DISABLED", servers: [] },
    call_hours: { status: "DISABLED" },
    call_icon_visibility: "DEFAULT",
    restrictions: { restrictions_list: [] },
  },
  access_token: "NEVER_PRINT_THIS",
  sip_user_password: "NEVER_PRINT_SIP_PASSWORD",
};

describe("InkaClick callback permission operator gates", () => {
  it("is hard-scoped to the approved Keyler business number", () => {
    expect(ops.PHONE_NUMBER_ID).toBe("740434745820831");
  });

  it("projects only non-sensitive calling fields and omits credentials", () => {
    const safe = ops.safeCallingSettings(baseline);
    expect(safe).toEqual({
      calling_status: "ENABLED",
      callback_permission_status: "DISABLED",
      call_permission_mode: "ALLOW_APPROVED_PERMISSION_ONLY",
      sip_status: "DISABLED",
      call_icon_visibility: "DEFAULT",
    });
    expect(JSON.stringify(safe)).not.toContain("NEVER_PRINT");
  });

  it("fails closed when calling is disabled or permission model is changed", () => {
    expect(() => ops.assertSafeCallingMode(ops.safeCallingSettings(baseline))).not.toThrow();
    const disabled = {
      calling: { ...baseline.calling, status: "DISABLED" },
    };
    expect(() => ops.assertSafeCallingMode(ops.safeCallingSettings(disabled)))
      .toThrow("CALLING_NOT_ENABLED");
    const qualityMode = {
      calling: { ...baseline.calling, call_permission_mode: "ALLOW_UNLESS_PERMISSION_REVOKED" },
    };
    expect(() => ops.assertSafeCallingMode(ops.safeCallingSettings(qualityMode)))
      .toThrow("PERMISSION_MODE_NOT_APPROVED_ONLY");
    const sipEnabled = { calling: { ...baseline.calling, sip: { status: "ENABLED" } } };
    expect(() => ops.assertSafeCallingMode(ops.safeCallingSettings(sipEnabled)))
      .toThrow("SIP_STATE_UNSAFE");
  });

  it("does not fail closed on Meta's documented default (omitted) SIP setting", () => {
    const missingSip = { calling: { ...baseline.calling, sip: undefined } };
    expect(() => ops.assertSafeCallingMode(ops.safeCallingSettings(missingSip))).not.toThrow();
  });

  it("constructs a single-field reversible update without toggling other features", () => {
    expect(ops.callbackPayload(true)).toEqual({
      calling: { callback_permission_status: "ENABLED" },
    });
    expect(ops.callbackPayload(false)).toEqual({
      calling: { callback_permission_status: "DISABLED" },
    });
    expect(JSON.stringify(ops.callbackPayload(true))).not.toContain("call_permission_mode");
    expect(JSON.stringify(ops.callbackPayload(true))).not.toContain("sip");
  });

  it("allows only callback changes, detecting unrelated calling setting drift", () => {
    const before = ops.unchangedCallingFields(baseline);
    const changedCallback = {
      calling: { ...baseline.calling, callback_permission_status: "ENABLED" },
    };
    expect(ops.unchangedCallingFields(changedCallback)).toBe(before);
    const changedSip = {
      calling: { ...baseline.calling, sip: { status: "ENABLED" } },
    };
    expect(ops.unchangedCallingFields(changedSip)).not.toBe(before);
  });

  it("decrypts real GCM/CBC fixture formats without exposing the key", () => {
    const key = randomBytes(32).toString("hex");
    const plaintext = "EAATESTCALLBACKTOKEN1234567890123456789";
    const ivGcm = randomBytes(12);
    const gcm = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), ivGcm);
    const cipherGcm = gcm.update(plaintext, "utf8", "hex") + gcm.final("hex");
    const encryptedGcm = [ivGcm.toString("hex"), cipherGcm, gcm.getAuthTag().toString("hex")].join(":");
    expect(ops.decryptToken(encryptedGcm, key)).toBe(plaintext);

    const ivCbc = randomBytes(16);
    const cbc = createCipheriv("aes-256-cbc", Buffer.from(key, "hex"), ivCbc);
    const cipherCbc = cbc.update(plaintext, "utf8", "hex") + cbc.final("hex");
    const encryptedCbc = [ivCbc.toString("hex"), cipherCbc].join(":");
    expect(ops.decryptToken(encryptedCbc, key)).toBe(plaintext);
    expect(() => ops.decryptToken(encryptedGcm, "bad-key")).toThrow("ENCRYPTION_KEY_INVALID");
  });
});
