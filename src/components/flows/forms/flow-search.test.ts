import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_FLOWS, normalizeSearch, searchFlows } from "./flow-search";

const flows = [
  { id: "1", name: "Bienvenida clientes" }, { id: "2", name: "QA - Lead capture" }, { id: "3", name: "Cotización Ñandú" },
  { id: "4", name: "Seguimiento Post-Venta" }, { id: "5", name: "bienvenida VIP" },
];

describe("normalizeSearch", () => {
  it("lower-cases, strips accents and collapses spaces", () => {
    expect(normalizeSearch("  Cotización   ÑANDÚ ")).toBe("cotizacion nandu");
    expect(normalizeSearch("Ünïcödé")).toBe("unicode");
  });
});

describe("searchFlows", () => {
  const ids = (q: string) => searchFlows(flows, q).visible.map((f) => f.id);
  it("an empty or blank query returns the whole catalog in its original order", () => { expect(ids("")).toEqual(["1", "2", "3", "4", "5"]); expect(ids("   ")).toEqual(["1", "2", "3", "4", "5"]); });
  it("matches part of the name, ignoring case", () => { expect(ids("BIENV")).toEqual(["1", "5"]); expect(ids("capture")).toEqual(["2"]); });
  it("ignores accents in both directions", () => { expect(ids("cotizacion")).toEqual(["3"]); expect(ids("COTIZACIÓN")).toEqual(["3"]); expect(ids("nandu")).toEqual(["3"]); expect(ids("seguimiento post venta")).toEqual(["4"]); expect(ids("post-venta")).toEqual(["4"]); });
  it("requires every term, in any order", () => { expect(ids("lead qa")).toEqual(["2"]); expect(ids("vip bienvenida")).toEqual(["5"]); expect(ids("bienvenida qa")).toEqual([]); });
  it("returns nothing for an unknown name", () => { expect(searchFlows(flows, "no existe").total).toBe(0); expect(ids("zzz")).toEqual([]); });
  it("never matches on the id, only on the name", () => { expect(ids("2")).toEqual([]); });
  it("caps what is rendered but reports the true total", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Flujo ${i}` }));
    const result = searchFlows(many, "");
    expect(result.visible).toHaveLength(MAX_VISIBLE_FLOWS); expect(result.total).toBe(1000);
    const narrow = searchFlows(many, "flujo 99");
    const expected = many.filter((f) => f.name.includes("99")).length; expect(narrow.total).toBe(expected); expect(narrow.visible).toHaveLength(expected);
  });
  it("stays fast on a thousand flows", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Automatización número ${i} de atención al cliente` }));
    const start = performance.now(); for (let i = 0; i < 50; i++) searchFlows(many, "atencion cliente 99"); expect(performance.now() - start).toBeLessThan(500);
  });
});
