import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyMetaWebhookSignature } from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyMetaWebhookSignature(body, signedHeader(body, "wrong"))).toBe(
      false,
    );
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto
      .createHmac("sha256", SECRET)
      .update(body)
      .digest("hex");
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyMetaWebhookSignature("{}", "sha256=tooshort")).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // feat/per-account-meta-app-secret — an explicit `appSecret` argument
  // lets a caller verify against ONE specific tenant's secret instead of
  // the global env var. webhook-tenant-secret.ts is what decides WHICH
  // secret(s) to try; this function's contract is just "check against
  // exactly the secret I was given."
  // -------------------------------------------------------------------
  describe("explicit appSecret argument (multi-tenant)", () => {
    it("verifies against the explicit secret, ignoring META_APP_SECRET entirely", () => {
      const tenantSecret = "tenant-a-secret";
      const body = JSON.stringify({ entry: [{ id: "waba-a" }] });
      const header = signedHeader(body, tenantSecret);

      // The global env secret is deliberately different — if the function
      // fell back to it, this would fail.
      expect(SECRET).not.toBe(tenantSecret);
      expect(verifyMetaWebhookSignature(body, header, tenantSecret)).toBe(true);
    });

    it("rejects a signature made with a different tenant's secret", () => {
      const body = JSON.stringify({ entry: [{ id: "waba-a" }] });
      const headerFromB = signedHeader(body, "tenant-b-secret");
      expect(
        verifyMetaWebhookSignature(body, headerFromB, "tenant-a-secret"),
      ).toBe(false);
    });

    it("never falls back to META_APP_SECRET when an explicit secret is given and wrong", () => {
      // Signed with the GLOBAL secret, but the caller is checking against
      // a specific tenant secret — must fail, not silently accept via env.
      const body = JSON.stringify({ entry: [{ id: "waba-a" }] });
      const headerFromGlobal = signedHeader(body, SECRET);
      expect(
        verifyMetaWebhookSignature(body, headerFromGlobal, "tenant-a-secret"),
      ).toBe(false);
    });

    it("does not touch process.env.META_APP_SECRET at all when appSecret is explicit — works even if the env var is unset", () => {
      const originalSecret = process.env.META_APP_SECRET;
      delete process.env.META_APP_SECRET;
      try {
        const tenantSecret = "tenant-a-secret";
        const body = "{}";
        const header = signedHeader(body, tenantSecret);
        expect(verifyMetaWebhookSignature(body, header, tenantSecret)).toBe(true);
      } finally {
        process.env.META_APP_SECRET = originalSecret;
      }
    });
  });
});
