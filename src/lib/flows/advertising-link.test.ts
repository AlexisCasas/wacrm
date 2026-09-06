import { describe, it, expect } from "vitest";
import {
  syncAdvertisingMessageIntoKeywords,
  manualKeywordsFrom,
  combineKeywords,
  normalizeWhatsAppDigits,
  buildWhatsAppAdvertisingLink,
} from "./advertising-link";

// ---------------------------------------------------------------------------
// Design fix: KeywordsInput must never see or comma-split the advertising
// message — it can legitimately contain commas ("Hola, quiero información
// sobre X, precio, stock y envío"), and KeywordsInput's own commit always
// re-splits its ENTIRE displayed value on ",". `manualKeywordsFrom` /
// `combineKeywords` are the two primitives that keep the two concerns split:
// KeywordsInput only ever reads/writes the manual subset; the advertising
// message is appended/removed as one atomic entry by the trigger panel.
// ---------------------------------------------------------------------------

describe("manualKeywordsFrom — spec §A (KeywordsInput must never display the ad message)", () => {
  it("excludes the exact advertising-message entry from the displayed set", () => {
    expect(
      manualKeywordsFrom(
        ["WACRM-PILOTO-XTD-001", "Hola, quiero información sobre Producto A"],
        "Hola, quiero información sobre Producto A",
      ),
    ).toEqual(["WACRM-PILOTO-XTD-001"]);
  });

  it("returns every keyword unchanged when there is no advertising message", () => {
    expect(manualKeywordsFrom(["support", "help"], "")).toEqual(["support", "help"]);
  });

  it("trims before comparing", () => {
    expect(
      manualKeywordsFrom(["a", "Producto A"], "  Producto A  "),
    ).toEqual(["a"]);
  });

  it("only removes the exact entry — a similar manual keyword survives", () => {
    expect(
      manualKeywordsFrom(["Producto A", "info Producto A"], "Producto A"),
    ).toEqual(["info Producto A"]);
  });
});

describe("combineKeywords — spec §B/E (the ad message is appended WHOLE, never split)", () => {
  it("appends the message as a single entry even with multiple commas inside it", () => {
    const result = combineKeywords(
      ["WACRM-PILOTO-XTD-001", "soporte"],
      "Hola, quiero información sobre X, precio, stock y envío",
    );
    expect(result).toEqual([
      "WACRM-PILOTO-XTD-001",
      "soporte",
      "Hola, quiero información sobre X, precio, stock y envío",
    ]);
    expect(result).toHaveLength(3);
  });

  it("clearing the message (empty string) contributes nothing — manual keywords pass through", () => {
    expect(combineKeywords(["WACRM-PILOTO-XTD-001", "soporte"], "")).toEqual([
      "WACRM-PILOTO-XTD-001",
      "soporte",
    ]);
  });

  it("never duplicates when a manual keyword already equals the message verbatim", () => {
    expect(combineKeywords(["Producto B"], "Producto B")).toEqual(["Producto B"]);
  });
});

describe("syncAdvertisingMessageIntoKeywords (spec §8.B/C/D)", () => {
  it("adds the advertising message to keywords the first time it's set", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["WACRM-PILOTO-XTD-001"],
      "",
      "Hola, quiero información sobre el Combo XTD Taladro + Amoladora",
    );
    expect(result).toEqual([
      "WACRM-PILOTO-XTD-001",
      "Hola, quiero información sobre el Combo XTD Taladro + Amoladora",
    ]);
  });

  it("replaces only the previous advertising message, preserving technical keywords", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["WACRM-PILOTO-XTD-001", "Hola, quiero información sobre Producto A"],
      "Hola, quiero información sobre Producto A",
      "Hola, quiero información sobre Producto B",
    );
    expect(result).toEqual([
      "WACRM-PILOTO-XTD-001",
      "Hola, quiero información sobre Producto B",
    ]);
    // Producto A must not linger as a residual trigger.
    expect(result).not.toContain("Hola, quiero información sobre Producto A");
  });

  it("does not create a duplicate when the new message already exists in keywords", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["WACRM-PILOTO-XTD-001", "Hola, quiero información sobre Producto B"],
      "",
      "Hola, quiero información sobre Producto B",
    );
    expect(result).toEqual([
      "WACRM-PILOTO-XTD-001",
      "Hola, quiero información sobre Producto B",
    ]);
  });

  it("trims both the previous and next message before comparing/inserting", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["WACRM-PILOTO-XTD-001", "Producto A"],
      "  Producto A  ",
      "  Producto B  ",
    );
    expect(result).toEqual(["WACRM-PILOTO-XTD-001", "Producto B"]);
  });

  it("clearing the advertising message removes the old entry and adds nothing", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["WACRM-PILOTO-XTD-001", "Producto A"],
      "Producto A",
      "",
    );
    expect(result).toEqual(["WACRM-PILOTO-XTD-001"]);
  });

  it("never touches keywords when there was and still is no advertising message", () => {
    const result = syncAdvertisingMessageIntoKeywords(["support", "help"], "", "");
    expect(result).toEqual(["support", "help"]);
  });

  it("only removes the exact previous-message entry — a similar manual keyword survives", () => {
    const result = syncAdvertisingMessageIntoKeywords(
      ["Producto A", "info Producto A"],
      "Producto A",
      "Producto B",
    );
    expect(result).toEqual(["info Producto A", "Producto B"]);
  });
});

describe("normalizeWhatsAppDigits (spec §8.E)", () => {
  it("strips +, spaces, hyphens, and parentheses down to bare digits", () => {
    expect(normalizeWhatsAppDigits("+51 915 362 074")).toBe("51915362074");
    expect(normalizeWhatsAppDigits("+1 (415) 555-0132")).toBe("14155550132");
  });

  it("returns an empty string for null/undefined/empty input", () => {
    expect(normalizeWhatsAppDigits(null)).toBe("");
    expect(normalizeWhatsAppDigits(undefined)).toBe("");
    expect(normalizeWhatsAppDigits("")).toBe("");
  });

  it("strips any other non-digit character (e.g. a stray letter)", () => {
    expect(normalizeWhatsAppDigits("ext.51915362074")).toBe("51915362074");
  });
});

describe("buildWhatsAppAdvertisingLink (spec §8.E/H)", () => {
  it("builds the exact wa.me URL with the message percent-encoded, '+' included", () => {
    const url = buildWhatsAppAdvertisingLink({
      displayPhoneNumber: "+51 915 362 074",
      advertisingMessage:
        "Hola, quiero información sobre el Combo XTD Taladro + Amoladora",
    });
    expect(url).toBe(
      "https://wa.me/51915362074?text=" +
        encodeURIComponent(
          "Hola, quiero información sobre el Combo XTD Taladro + Amoladora",
        ),
    );
    // The "+" in the product name must be percent-encoded (%2B), never
    // left raw — a raw "+" in a URL query string decodes as a space.
    expect(url).toContain("Taladro%20%2B%20Amoladora");
    expect(url).not.toContain("Taladro + Amoladora");
  });

  it("returns null when there is no advertising message", () => {
    expect(
      buildWhatsAppAdvertisingLink({
        displayPhoneNumber: "+51 915 362 074",
        advertisingMessage: "",
      }),
    ).toBeNull();
    expect(
      buildWhatsAppAdvertisingLink({
        displayPhoneNumber: "+51 915 362 074",
        advertisingMessage: undefined,
      }),
    ).toBeNull();
    expect(
      buildWhatsAppAdvertisingLink({
        displayPhoneNumber: "+51 915 362 074",
        advertisingMessage: "   ",
      }),
    ).toBeNull();
  });

  it("returns null when the phone number can't be resolved", () => {
    expect(
      buildWhatsAppAdvertisingLink({
        displayPhoneNumber: null,
        advertisingMessage: "Hola",
      }),
    ).toBeNull();
    expect(
      buildWhatsAppAdvertisingLink({
        displayPhoneNumber: "",
        advertisingMessage: "Hola",
      }),
    ).toBeNull();
  });

  it("never builds a link when both inputs are missing", () => {
    expect(
      buildWhatsAppAdvertisingLink({ displayPhoneNumber: null, advertisingMessage: null }),
    ).toBeNull();
  });
});
