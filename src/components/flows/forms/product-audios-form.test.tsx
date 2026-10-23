// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NodeConfigForm } from "./node-config-form";
import type { BuilderNode } from "../shared";

const TAG = "11111111-1111-4111-8111-111111111111";
const FIELD = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "44444444-4444-4444-8444-444444444444";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct-1" }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        order: async () => ({
          data: table === "tags" ? [{ id: TAG, name: "audio_guia", color: null }] : table === "custom_fields" ? [{ id: FIELD, field_name: "Producto" }, { id: "55555555-5555-4555-8555-555555555555", field_name: "Marca" }] : [],
          error: null,
        }),
      }),
    }),
  }),
}));

const fetchMock = vi.fn<(url: string) => Promise<Response>>();
let products: Array<Record<string, unknown>>;
let productsStatus: number;
let productsBody: Record<string, unknown> | null;

beforeEach(() => {
  products = [{ id: PRODUCT, product_key: "taladro pro", display_name: "Taladro Pro", active: true }, { id: "66666666-6666-4666-8666-666666666666", product_key: "viejo", display_name: "Producto viejo", active: false }];
  productsStatus = 200;
  productsBody = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: productsStatus < 400, status: productsStatus, json: async () => productsBody ?? { products } }) as Response);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const legacy = { gate_tag_id: TAG, product_field_id: "", next_node_key: "a", unknown_node_key: "b", no_audios_node_key: "c", gate_closed_node_key: "d" };
const fresh = { gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", next_node_key: "", unknown_node_key: "", no_audios_node_key: "", gate_closed_node_key: "" };
const node = (config: Record<string, unknown>): BuilderNode => ({ node_key: "vp", node_type: "send_product_audios", config }) as BuilderNode;
const others: BuilderNode[] = ["a", "b", "c", "d"].map((k) => ({ node_key: k, node_type: "end", config: {} }) as BuilderNode);

function mount(config: Record<string, unknown>) {
  const onUpdateConfig = vi.fn();
  render(<NodeConfigForm node={node(config)} allNodes={[node(config), ...others]} showAdvanced={false} onUpdateConfig={onUpdateConfig} />);
  return onUpdateConfig;
}
const checked = (testId: string) => (screen.getByTestId(testId).querySelector("input") as HTMLInputElement).checked;

describe("Audios por producto form: the two explicit choices", () => {
  it("a node saved before the options existed shows 'tag required' and 'from the contact', and writes nothing on its own", async () => {
    const onUpdate = mount(legacy);
    expect(checked("gate-required")).toBe(true);
    expect(checked("gate-none")).toBe(false);
    expect(checked("source-auto")).toBe(true);
    expect(await screen.findByTestId("gate-tag-name")).toHaveProperty("textContent", "audio_guia"); // the real tag name, not its id
    expect(screen.getByText("productAudiosRouteGateClosed")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a new node starts without a tag, from the contact, and does not ask for the 'gate closed' step", () => {
    mount(fresh);
    expect(checked("gate-none")).toBe(true);
    expect(checked("source-auto")).toBe(true);
    expect(screen.queryByTestId("gate-tag-name")).toBeNull();
    expect(screen.queryByText("productAudiosRouteGateClosed")).toBeNull();
    for (const label of ["productAudiosRouteNext", "productAudiosRouteUnknown", "productAudiosRouteNoAudios"]) expect(screen.getByText(label)).toBeTruthy();
  });

  it("switching to 'require a tag' keeps everything and asks for the tag; the 'gate closed' step appears", () => {
    const onUpdate = mount(fresh);
    fireEvent.click(screen.getByTestId("gate-required").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ gate_mode: "required" });
  });

  it("switching to 'no extra tag' clears the tag and the 'gate closed' step, so no hidden condition is left behind", () => {
    const onUpdate = mount(legacy);
    fireEvent.click(screen.getByTestId("gate-none").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ gate_mode: "none", gate_tag_id: "", gate_closed_node_key: "" });
  });

  it("warns when a required tag has not been chosen yet", () => {
    mount({ ...legacy, gate_tag_id: "" });
    expect(screen.getByText("productAudiosGateMissing")).toBeTruthy();
  });

  it("switching to a product picked by hand clears the contact field; back to automatic clears the product", () => {
    let onUpdate = mount(fresh);
    fireEvent.click(screen.getByTestId("source-manual").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ product_source: "manual", product_field_id: "" });
    cleanup();
    onUpdate = mount({ ...fresh, product_source: "manual", product_id: PRODUCT });
    fireEvent.click(screen.getByTestId("source-auto").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ product_source: "auto", product_id: "" });
  });
});

describe("Audios por producto form: real names, help and examples", () => {
  it("the manual product shows the catalog's NAME (and marks a disabled one), never only the id", async () => {
    mount({ ...fresh, product_source: "manual", product_id: PRODUCT });
    expect((await screen.findByTestId("product-name")).textContent).toBe("Taladro Pro");
    expect(fetchMock).toHaveBeenCalledWith("/api/audio-guide/products");
  });

  it("a disabled product is flagged; a product that no longer exists is reported", async () => {
    mount({ ...fresh, product_source: "manual", product_id: "66666666-6666-4666-8666-666666666666" });
    expect((await screen.findByTestId("product-name")).textContent).toContain("productAudiosProductInactive");
    cleanup();
    mount({ ...fresh, product_source: "manual", product_id: "77777777-7777-4777-8777-777777777777" });
    expect(await screen.findByText("productAudiosProductUnavailable")).toBeTruthy();
  });

  it("asks for a product when none is chosen", async () => {
    mount({ ...fresh, product_source: "manual", product_id: "" });
    expect(await screen.findByText("productAudiosProductMissing")).toBeTruthy();
  });

  it("explains each case: every choice and every output has an information icon and an example", async () => {
    mount(legacy);
    await screen.findByTestId("gate-tag-name");
    for (const key of ["productAudiosGateNoneExample", "productAudiosGateRequiredExample", "productAudiosSourceAutoExample", "productAudiosSourceManualExample", "productAudiosRouteNextExample", "productAudiosRouteUnknownExample", "productAudiosRouteNoAudiosExample", "productAudiosRouteGateClosedExample"]) {
      expect(screen.getAllByText(key).length, key).toBeGreaterThan(0);
    }
    expect(document.querySelectorAll('[role="img"][title]').length).toBeGreaterThanOrEqual(6);
    for (const key of ["productAudiosGateTitle", "productAudiosSourceTitle"]) expect(screen.getByText(key)).toBeTruthy();
  });

  it("shows the real name of the chosen contact field in automatic mode", async () => {
    mount({ ...fresh, product_field_id: FIELD });
    await waitFor(() => expect(screen.getByTestId("field-name").textContent).toBe("Producto"));
  });

  it("tells the person when the module is not enabled for the account or the catalog is empty or fails", async () => {
    productsStatus = 403; productsBody = { error: "voice_notes_disabled" };
    mount({ ...fresh, product_source: "manual" });
    expect(await screen.findByText("productAudiosProductsDisabled")).toBeTruthy();
    cleanup();
    productsStatus = 200; productsBody = { products: [] };
    mount({ ...fresh, product_source: "manual" });
    expect(await screen.findByText("productAudiosProductsEmpty")).toBeTruthy();
    cleanup();
    productsStatus = 500; productsBody = {};
    mount({ ...fresh, product_source: "manual" });
    expect(await screen.findByText("productAudiosProductsError")).toBeTruthy();
  });
});
