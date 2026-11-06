import { describe, expect, it } from "vitest";
import { draftFromLegacy, emptyOrderItem, itemsForSubmission, moneyDisplay, subtotalCents } from "./order-items-editor";

describe("multiproduct UI calculation", () => {
  it("starts with an empty valid quantity and no invented unit price", () => {
    expect(emptyOrderItem()).toMatchObject({ product_name: "", quantity: "1", unit_price: "", catalog_product_id: null, row_id: expect.any(String) });
  });

  it("preserves a unique UI row ID when editing or removing other rows, without sending it to the API", () => {
    const first = emptyOrderItem();
    const second = emptyOrderItem();
    expect(first.row_id).not.toBe(second.row_id);
    const updated = { ...second, product_name: "Tetera" };
    expect(updated.row_id).toBe(second.row_id);
    const remaining = [first, updated].filter((row) => row.row_id !== first.row_id);
    expect(remaining[0].row_id).toBe(second.row_id);
    expect(itemsForSubmission(remaining)[0]).not.toHaveProperty("row_id");
  });

  it("pre-fills a unit price only for a single-unit legacy order", () => {
    expect(draftFromLegacy({ product: "Nivel laser", quantity: "1", price: "155.00" }))
      .toMatchObject({ product_name: "Nivel laser", quantity: "1", unit_price: "155.00" });
    expect(draftFromLegacy({ product: "Nivel laser", quantity: "2", price: "310.00" }))
      .toMatchObject({ product_name: "Nivel laser", quantity: "2", unit_price: "" });
    expect(draftFromLegacy({ product: "1 x A\n1 x B", quantity: "2", price: "300.00" }).product_name).toBe("");
  });

  it("calculates line subtotals in integer cents and rejects incomplete fields", () => {
    const line = { ...emptyOrderItem(), product_name: "Tetera", quantity: "3", unit_price: "19,99" };
    expect(subtotalCents(line)).toBe(5997);
    expect(moneyDisplay(5997)).toBe("S/ 59.97");
    expect(subtotalCents({ ...line, unit_price: "" })).toBeNull();
    expect(subtotalCents({ ...line, quantity: "1.5" })).toBeNull();
    expect(subtotalCents({ ...line, quantity: "0" })).toBeNull();
  });

  it("submits only the four permitted structured fields, not derived UI fields", () => {
    const lines = [{ ...emptyOrderItem(), product_name: "Tetera", quantity: "2", unit_price: "90" }];
    expect(itemsForSubmission(lines)).toEqual([{
      product_name: "Tetera", quantity: "2", unit_price: "90", catalog_product_id: null,
    }]);
  });
});
