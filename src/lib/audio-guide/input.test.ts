import { describe, expect, it } from "vitest";
import {
  parseAddItem, parseCreateProduct, parseReorder, parseRevision, parseSaveProduct, parseUpdateItem,
} from "./input";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const SHA = "a".repeat(64);
const staged = (account = A) => `account-${account}/voice-staging/1700000000000-guia.ogg`;
const err = (r: { ok: boolean }) => (r.ok ? null : (r as unknown as { field: string; error: string }));

describe("parseRevision", () => {
  it.each([[1, true], [42, true], ["7", true], [0, false], [-1, false], [1.5, false], ["x", false], [null, false], [undefined, false], [3_000_000_000, false]])("%j -> %s", (v, valid) => {
    expect(parseRevision(v).ok).toBe(valid);
  });
});

describe("parseCreateProduct", () => {
  it("accepts a visible name and defaults the product value to it", () => {
    expect(parseCreateProduct({ display_name: "  Combo   XTD " })).toEqual({ ok: true, value: { displayName: "Combo XTD", productValue: "Combo XTD" } });
    expect(parseCreateProduct({ display_name: "Combo XTD", product_value: "combo xtd taladro" })).toMatchObject({ ok: true, value: { productValue: "combo xtd taladro" } });
  });
  it("rejects a missing, blank, over-long or non-text name and a non-text value", () => {
    expect(err(parseCreateProduct({}))?.error).toBe("display_name_required");
    expect(err(parseCreateProduct({ display_name: "   " }))?.error).toBe("display_name_required");
    expect(err(parseCreateProduct({ display_name: "x".repeat(121) }))?.error).toBe("display_name_too_long");
    expect(err(parseCreateProduct({ display_name: 5 }))?.error).toBe("display_name_required");
    expect(err(parseCreateProduct({ display_name: "ok", product_value: 5 }))?.field).toBe("product_value");
    for (const body of [null, undefined, "x", [], 7]) expect(err(parseCreateProduct(body))?.error).toBe("invalid_body");
  });
  it("ignores an account id smuggled in the body", () => {
    expect(parseCreateProduct({ display_name: "X", account_id: B })).toEqual({ ok: true, value: { displayName: "X", productValue: "X" } });
  });
});

describe("parseSaveProduct", () => {
  it("needs the revision and at least one change, and types each field", () => {
    expect(parseSaveProduct({ expected_revision: 3, display_name: "Nuevo", active: false })).toEqual({ ok: true, value: { expectedRevision: 3, displayName: "Nuevo", active: false } });
    expect(err(parseSaveProduct({ display_name: "x" }))?.error).toBe("expected_revision_required");
    expect(err(parseSaveProduct({ expected_revision: 3 }))?.error).toBe("nothing_to_change");
    expect(err(parseSaveProduct({ expected_revision: 3, active: "yes" }))?.field).toBe("active");
    expect(err(parseSaveProduct({ expected_revision: 3, product_value: 1 }))?.field).toBe("product_value");
  });
});

describe("parseAddItem", () => {
  it("accepts a staged upload of THIS account or a stored hash, never both, never neither", () => {
    expect(parseAddItem({ expected_revision: 1, path: staged() }, A)).toEqual({ ok: true, value: { expectedRevision: 1, source: { kind: "staged", path: staged() } } });
    expect(parseAddItem({ expected_revision: 1, sha256: SHA }, A)).toEqual({ ok: true, value: { expectedRevision: 1, source: { kind: "stored", sha256: SHA } } });
    expect(err(parseAddItem({ expected_revision: 1, path: staged(), sha256: SHA }, A))?.error).toBe("exactly_one_of_path_or_sha256");
    expect(err(parseAddItem({ expected_revision: 1 }, A))?.error).toBe("exactly_one_of_path_or_sha256");
  });
  it("never accepts a URL, in any spelling, as the audio", () => {
    for (const field of ["url", "media_url", "voice_path", "path_url"]) {
      expect(err(parseAddItem({ expected_revision: 1, sha256: SHA, [field]: "https://cdn.example/x.ogg" }, A))).toEqual({ ok: false, field, error: "url_not_accepted" });
    }
    expect(err(parseAddItem({ expected_revision: 1, path: "https://cdn.example/x.ogg" }, A))?.error).toBe("invalid_path");
  });
  it("refuses another account's staged path, traversal and malformed hashes", () => {
    expect(err(parseAddItem({ expected_revision: 1, path: staged(B) }, A))?.error).toBe("invalid_path");
    expect(err(parseAddItem({ expected_revision: 1, path: `account-${A}/voice-staging/../x.ogg` }, A))?.error).toBe("invalid_path");
    expect(err(parseAddItem({ expected_revision: 1, path: `account-${A}/1700000000000-inbox.ogg` }, A))?.error).toBe("invalid_path");
    for (const sha of ["A".repeat(64), "a".repeat(63), "g".repeat(64), 5, null]) expect(err(parseAddItem({ expected_revision: 1, sha256: sha }, A))?.error).toBe("invalid_hash");
  });
  it("validates label and pause", () => {
    expect(parseAddItem({ expected_revision: 1, sha256: SHA, label: " Guía 1 ", pre_delay_seconds: 5 }, A)).toMatchObject({ ok: true, value: { label: "Guía 1", preDelaySeconds: 5 } });
    expect(err(parseAddItem({ expected_revision: 1, sha256: SHA, pre_delay_seconds: 4 }, A))?.error).toBe("pause_out_of_range");
    expect(err(parseAddItem({ expected_revision: 1, sha256: SHA, pre_delay_seconds: 31 }, A))?.error).toBe("pause_out_of_range");
    expect(err(parseAddItem({ expected_revision: 1, sha256: SHA, pre_delay_seconds: 5.5 }, A))?.error).toBe("pause_out_of_range");
    expect(err(parseAddItem({ expected_revision: 1, sha256: SHA, label: "x".repeat(121) }, A))?.error).toBe("label_too_long");
  });
});

describe("parseUpdateItem", () => {
  it("accepts status, pause and label; null clears the label", () => {
    expect(parseUpdateItem({ expected_revision: 2, status: "disabled", pre_delay_seconds: 12 })).toEqual({ ok: true, value: { expectedRevision: 2, status: "disabled", preDelaySeconds: 12 } });
    expect(parseUpdateItem({ expected_revision: 2, label: null })).toEqual({ ok: true, value: { expectedRevision: 2, clearLabel: true } });
  });
  it("says so when the file of an item is addressed: it can never change", () => {
    for (const f of ["sha256", "voice_sha256", "voice_path", "url", "media_url", "path", "bytes", "duration_ms", "position"]) {
      expect(err(parseUpdateItem({ expected_revision: 2, [f]: "x" }))).toEqual({ ok: false, field: f, error: "field_not_editable" });
    }
  });
  it("refuses an unknown status, nothing to change, a missing revision", () => {
    expect(err(parseUpdateItem({ expected_revision: 2, status: "paused" }))?.error).toBe("status_invalid");
    expect(err(parseUpdateItem({ expected_revision: 2 }))?.error).toBe("nothing_to_change");
    expect(err(parseUpdateItem({ status: "active" }))?.error).toBe("expected_revision_required");
  });
});

describe("parseReorder", () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  it("accepts 1..6 distinct uuids", () => {
    expect(parseReorder({ expected_revision: 1, item_ids: ids })).toEqual({ ok: true, value: { expectedRevision: 1, itemIds: ids } });
  });
  it("refuses empty, too many, repeated (case-insensitive) and non-uuid ids", () => {
    expect(err(parseReorder({ expected_revision: 1, item_ids: [] }))?.error).toBe("item_ids_invalid");
    expect(err(parseReorder({ expected_revision: 1, item_ids: [...ids, ...ids, ...ids, ids[0]] }))?.error).toBe("item_ids_invalid");
    expect(err(parseReorder({ expected_revision: 1, item_ids: [ids[0], ids[0].toUpperCase()] }))?.error).toBe("item_ids_repeated");
    expect(err(parseReorder({ expected_revision: 1, item_ids: ["x", ids[0]] }))?.error).toBe("item_ids_invalid");
    expect(err(parseReorder({ expected_revision: 1 }))?.error).toBe("item_ids_invalid");
  });
});
