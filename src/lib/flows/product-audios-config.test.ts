import { describe, expect, it } from "vitest";
import { gateModeOf, inspectProductAudiosConfig, productAudiosRouteKeys, productSourceOf, selectionOf } from "./product-audios-config";

const TAG = "11111111-1111-4111-8111-111111111111";
const FIELD = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "44444444-4444-4444-8444-444444444444";
const codes = (cfg: Record<string, unknown>) => inspectProductAudiosConfig(cfg).map((p) => p.code);

describe("a node saved BEFORE the new choices existed keeps its behaviour", () => {
  const legacy = { gate_tag_id: TAG, product_field_id: "", next_node_key: "a", unknown_node_key: "b", no_audios_node_key: "c", gate_closed_node_key: "d" };

  it("reads as 'tag required' and 'product from the contact', and needs all four outputs", () => {
    expect(gateModeOf(legacy)).toBe("required");
    expect(productSourceOf(legacy)).toBe("auto");
    expect(productAudiosRouteKeys(legacy)).toEqual(["next_node_key", "unknown_node_key", "no_audios_node_key", "gate_closed_node_key"]);
    expect(codes(legacy)).toEqual([]);
  });

  it("does NOT lose its tag condition: without a tag it is still invalid (never silently open)", () => {
    expect(codes({ ...legacy, gate_tag_id: "" })).toContain("product_audios_gate_missing");
    expect(codes({ ...legacy, gate_tag_id: undefined })).toContain("product_audios_gate_missing");
  });

  it("a null or missing choice means the legacy meaning, never 'no tag'", () => {
    expect(gateModeOf({ gate_mode: null })).toBe("required");
    expect(gateModeOf({})).toBe("required");
    expect(productSourceOf({ product_source: null })).toBe("auto");
  });
});

describe("gate: require a tag or not", () => {
  it("'none' needs no tag and no 'gate closed' output", () => {
    const cfg = { gate_mode: "none", gate_tag_id: "", next_node_key: "a", unknown_node_key: "b", no_audios_node_key: "c" };
    expect(codes(cfg)).toEqual([]);
    expect(productAudiosRouteKeys(cfg)).toEqual(["next_node_key", "unknown_node_key", "no_audios_node_key"]);
  });
  it("'required' needs a valid tag of the account's tags (uuid) and the 'gate closed' output", () => {
    expect(codes({ gate_mode: "required", gate_tag_id: TAG })).toEqual([]);
    expect(codes({ gate_mode: "required", gate_tag_id: "" })).toEqual(["product_audios_gate_missing"]);
    expect(codes({ gate_mode: "required", gate_tag_id: "nope" })).toEqual(["product_audios_gate_missing"]);
    expect(productAudiosRouteKeys({ gate_mode: "required" })).toContain("gate_closed_node_key");
  });
  it("'none' with a tag still set is a contradiction, not a silently ignored condition", () => {
    expect(codes({ gate_mode: "none", gate_tag_id: TAG })).toEqual(["product_audios_gate_conflict"]);
  });
  it("an unknown value is invalid, never guessed", () => {
    for (const bad of ["optional", "", "NONE", 0, true]) {
      expect(gateModeOf({ gate_mode: bad })).toBe("invalid");
      expect(codes({ gate_mode: bad, gate_tag_id: TAG })).toContain("product_audios_gate_mode_invalid");
    }
  });
});

describe("product: from the contact (auto) or chosen from the catalog (manual)", () => {
  const base = { gate_mode: "none", gate_tag_id: "" };
  it("auto reads the Producto field; an explicit field must be empty or a uuid", () => {
    expect(codes({ ...base, product_source: "auto" })).toEqual([]);
    expect(codes({ ...base, product_source: "auto", product_field_id: FIELD })).toEqual([]);
    expect(codes({ ...base, product_source: "auto", product_field_id: "nope" })).toEqual(["product_audios_field_invalid"]);
  });
  it("manual needs a catalog product id (uuid)", () => {
    expect(codes({ ...base, product_source: "manual", product_id: PRODUCT })).toEqual([]);
    for (const bad of ["", undefined, "nope", 5]) expect(codes({ ...base, product_source: "manual", product_id: bad })).toEqual(["product_audios_product_missing"]);
  });
  it("manual with a contact field, or auto with a product, is a contradiction", () => {
    expect(codes({ ...base, product_source: "manual", product_id: PRODUCT, product_field_id: FIELD })).toEqual(["product_audios_source_conflict"]);
    expect(codes({ ...base, product_source: "auto", product_id: PRODUCT })).toEqual(["product_audios_source_conflict"]);
  });
  it("an unknown source is invalid", () => {
    expect(productSourceOf({ product_source: "ai" })).toBe("invalid");
    expect(codes({ ...base, product_source: "ai" })).toContain("product_audios_source_invalid");
  });
});

describe("forward compatibility: a selection this version cannot run is refused, never read as 'all'", () => {
  const base = { gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "" };

  it("the original behaviour is untouched: the field absent, null or 'all' sends every audio", () => {
    for (const cfg of [base, { ...base, audio_selection: undefined }, { ...base, audio_selection: null }, { ...base, audio_selection: "all" }]) {
      expect(selectionOf(cfg)).toBe("all");
      expect(codes(cfg)).toEqual([]);
    }
    expect(codes({ gate_tag_id: TAG, product_field_id: "" })).toEqual([]); // a node saved before any of the options
  });

  it("'single' (written by a newer version) is refused", () => {
    expect(selectionOf({ ...base, audio_selection: "single" })).toBe("unsupported");
    expect(codes({ ...base, audio_selection: "single", purpose_id: PRODUCT, identifier_id: FIELD })).toContain("product_audios_selection_unsupported");
  });

  it("any other value is refused too (typos, a future mode, the wrong type)", () => {
    for (const bad of ["ALL", "One", "group", "", 0, 1, true, false, {}, []]) {
      expect(selectionOf({ ...base, audio_selection: bad }), String(bad)).toBe("unsupported");
      expect(codes({ ...base, audio_selection: bad }), String(bad)).toContain("product_audios_selection_unsupported");
    }
  });

  it("a purpose or an identifier, even without the mode, is refused instead of ignored", () => {
    expect(codes({ ...base, purpose_id: PRODUCT })).toContain("product_audios_selection_unsupported");
    expect(codes({ ...base, identifier_id: PRODUCT })).toContain("product_audios_selection_unsupported");
    expect(codes({ ...base, audio_selection: "all", purpose_id: PRODUCT })).toContain("product_audios_selection_unsupported");
    // empty strings are what an editor writes for 'not chosen': they are fine
    expect(codes({ ...base, purpose_id: "", identifier_id: "" })).toEqual([]);
  });

  it("the guard does not hide the other checks", () => {
    expect(codes({ ...base, audio_selection: "single", product_source: "ai" })).toEqual(expect.arrayContaining(["product_audios_selection_unsupported", "product_audios_source_invalid"]));
  });
});
