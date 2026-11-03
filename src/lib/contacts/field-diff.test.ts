import { describe, expect, it } from "vitest";
import { changedCustomFieldIds } from "./field-diff";

const fields = [{ id: "product" }, { id: "destination" }, { id: "advance" }];

describe("changedCustomFieldIds", () => {
  it("never includes unchanged fields, even when they are empty", () => {
    expect(changedCustomFieldIds(fields,
      { product: "Hidrolavadora", destination: "", advance: "50" },
      { product: "Hidrolavadora", advance: "50" },
    )).toEqual([]);
  });

  it("returns only the modified field IDs, keeping the definition order", () => {
    expect(changedCustomFieldIds(fields,
      { product: "Taladro", advance: "40", destination: "Lima" },
      { product: "Taladro", advance: "50", destination: "" },
    )).toEqual(["destination", "advance"]);
  });

  it("detects explicit clearing of an existing value", () => {
    expect(changedCustomFieldIds(fields,
      { product: "", destination: "" },
      { product: "Hidrolavadora", destination: "" },
    )).toEqual(["product"]);
  });

  it("ignores insignificant leading or trailing whitespace", () => {
    expect(changedCustomFieldIds(fields,
      { product: "  Hidrolavadora  " },
      { product: "Hidrolavadora" },
    )).toEqual([]);
  });

  it("never treats fields outside the current account catalog as editable", () => {
    expect(changedCustomFieldIds([{ id: "product" }],
      { product: "Taladro", otherAccountField: "changed" },
      { product: "Taladro", otherAccountField: "old" },
    )).toEqual([]);
  });
});
