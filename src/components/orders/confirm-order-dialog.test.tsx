// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [
            { value: "Nivel laser", custom_fields: { field_name: "Producto" } },
            { value: "150", custom_fields: { field_name: "Precio" } },
            { value: "Arequipa", custom_fields: { field_name: "Destino" } },
          ],
        }),
      }),
    }),
  }),
}));

import { ConfirmOrderDialog } from "./confirm-order-dialog";
import { toast } from "sonner";

const sellers = [{ id: "11111111-1111-4111-8111-111111111111", name: "Vendedor Uno" }];
const contact = { id: "22222222-2222-4222-8222-222222222222", name: "Cliente Sintetico", phone: "900000001" };

function setup(multiproductEnabled = false, catalogRequired = false) {
  const onOpenChange = vi.fn();
  render(<ConfirmOrderDialog open onOpenChange={onOpenChange} contact={contact} conversationId="33333333-3333-4333-8333-333333333333" sellers={sellers} multiproductEnabled={multiproductEnabled} catalogRequired={catalogRequired} />);
  return { onOpenChange };
}
const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

// Both dropdowns are the themed Select (not a native <select>): open the list, then press the option by its visible name.
async function choose(id: string, name: string) {
  const press = (el: Element) => {
    fireEvent.pointerDown(el, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { button: 0 });
  };
  press(document.getElementById(id)!);
  const option = await screen.findByRole("option", { name });
  await new Promise((r) => setTimeout(r, 300)); // base-ui ignores an item press that follows the open too closely
  press(option);
}
const pickSeller = (name = sellers[0].name) => choose("order-seller", name);

async function reachPreview() {
  await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
  await pickSeller();
  fireEvent.click(screen.getByText("review"));
  await screen.findByTestId("order-preview");
}

describe("ConfirmOrderDialog", () => {
  beforeEach(() => {
    let n = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `key-${++n}` });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("continues showing a client-side invalid price after editing the classic form", async () => {
    setup();
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.change(document.getElementById("order-price")!, { target: { value: "0" } });
    expect(screen.getByText("errors.invalid_price")).toBeTruthy();
    fireEvent.change(document.getElementById("order-product")!, { target: { value: "Otro producto" } });
    expect(screen.getByText("errors.invalid_price")).toBeTruthy();
    expect(screen.getByText("review").closest("button")).toBeDisabled();
  });

  it("keeps a multi-item validation error visible after editing a different field", async () => {
    setup(true);
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.click(screen.getByText("lineMultiMode"));
    fireEvent.change(document.getElementById("order-item-unit-price-0")!, { target: { value: "0" } });
    expect(screen.getByText("errors.invalid_price")).toBeTruthy();
    fireEvent.change(document.getElementById("order-item-quantity-0")!, { target: { value: "2" } });
    expect(screen.getByText("errors.invalid_price")).toBeTruthy();
    expect(screen.getByText("review").closest("button")).toBeDisabled();
  });

  it("offers a visible catalog search in each line and selects a result without inventing a price or sending an order", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/orders/products?q=hidro"))
        return new Response(JSON.stringify({ products: [
          { id: "44444444-4444-4444-8444-444444444444", display_name: "Hidrolavadora INGCO", active: true },
        ] }), { status: 200 });
      return new Response(JSON.stringify({ products: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setup(true);
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.click(screen.getByText("lineMultiMode"));
    fireEvent.click(screen.getByText("lineAdd"));
    expect(screen.getAllByText("lineCatalogBrowse")).toHaveLength(2);
    expect(value("order-item-unit-price-1")).toBe("");
    fireEvent.click(screen.getAllByText("lineCatalogBrowse")[1]);
    fireEvent.change(document.getElementById("order-catalog-search-1")!, { target: { value: "hidro" } });
    fireEvent.click(await screen.findByText("Hidrolavadora INGCO"));
    expect(value("order-item-product-1")).toBe("Hidrolavadora INGCO");
    expect(value("order-item-unit-price-1")).toBe("");
    expect(screen.getByText("lineFromCatalog")).toBeTruthy();
    expect(screen.queryByTestId("order-catalog-picker-1")).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/api/orders/products"))).toBe(true);
    fireEvent.change(document.getElementById("order-item-product-1")!, { target: { value: "Producto libre" } });
    expect(screen.queryByText("lineFromCatalog")).toBeNull();
    expect(value("order-item-product-1")).toBe("Producto libre");
  });

  it("explains no catalog matches and keeps free-text entry available when the catalog fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("noexiste")) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "catalog_unavailable" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setup(true);
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.click(screen.getByText("lineMultiMode"));
    fireEvent.click(screen.getByText("lineCatalogBrowse"));
    fireEvent.change(document.getElementById("order-catalog-search-0")!, { target: { value: "noexiste" } });
    await screen.findByText("lineCatalogNoResults");
    fireEvent.change(document.getElementById("order-catalog-search-0")!, { target: { value: "fallo" } });
    await screen.findByText("lineCatalogUnavailable");
    fireEvent.click(screen.getByText("lineCatalogClose"));
    fireEvent.change(document.getElementById("order-item-product-0")!, { target: { value: "Producto manual" } });
    expect(value("order-item-product-0")).toBe("Producto manual");
    expect(value("order-item-unit-price-0")).toBe("150");
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/api/orders/products"))).toBe(true);
  });

  it("requires a selected commercial product tag in single mode; prefilled free text is not sufficient", async () => {
    const CATALOG_ID = "44444444-4444-4444-8444-444444444444";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      new Response(JSON.stringify({ products: [{ id: CATALOG_ID, display_name: "Cargador Xiaomi", active: true }] }), { status: 200 })
    )));
    setup(true, true);
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    expect((document.getElementById("order-product") as HTMLInputElement).readOnly).toBe(true);
    await pickSeller();
    expect(screen.getByText("review").closest("button")).toBeDisabled();
    fireEvent.change(document.getElementById("order-catalog-search-single")!, { target: { value: "Cargador" } });
    fireEvent.click(await screen.findByText("Cargador Xiaomi"));
    expect(value("order-product")).toBe("Cargador Xiaomi");
    expect(screen.getByText("review").closest("button")).not.toBeDisabled();
    expect(screen.getByText("orderDescription")).toBeTruthy(); // Notes remain a separate free-text field.
  });

  it("strict multiple items cannot be reviewed if any line lacks a selected catalogue product", async () => {
    const CATALOG_ID = "44444444-4444-4444-8444-444444444444";
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ products: [{ id: CATALOG_ID, display_name: "Cargador Xiaomi", active: true }] }), { status: 200 })
    )));
    setup(true, true);
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    fireEvent.click(screen.getByText("lineMultiMode"));
    await pickSeller();
    expect((document.getElementById("order-item-product-0") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("review").closest("button")).toBeDisabled();
    fireEvent.click(screen.getByText("lineCatalogBrowse"));
    fireEvent.change(document.getElementById("order-catalog-search-0")!, { target: { value: "Cargador" } });
    fireEvent.click(await screen.findByText("Cargador Xiaomi"));
    expect(screen.getByText("review").closest("button")).not.toBeDisabled();
    fireEvent.click(screen.getByText("lineAdd"));
    expect(screen.getByText("review").closest("button")).toBeDisabled();
  });

  it("keeps multi-item controls hidden for accounts without the feature", async () => {
    setup();
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    expect(screen.queryByText("lineMultiMode")).toBeNull();
    expect(screen.queryByTestId("order-items-editor")).toBeNull();
  });

  it("for an enabled account, previews and submits two item lines with computed totals", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/orders/products")) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      return new Response(JSON.stringify({ order_id: "multi-order", created: true, delivery_status: "pending" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { onOpenChange } = setup(true);
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.click(screen.getByText("lineMultiMode"));
    expect(screen.getByTestId("order-items-editor")).toBeTruthy();
    expect(value("order-item-product-0")).toBe("Nivel laser");
    expect(value("order-item-unit-price-0")).toBe("150");
    fireEvent.click(screen.getByText("lineAdd"));
    fireEvent.change(document.getElementById("order-item-product-1")!, { target: { value: "Tetera" } });
    fireEvent.change(document.getElementById("order-item-quantity-1")!, { target: { value: "2" } });
    fireEvent.change(document.getElementById("order-item-unit-price-1")!, { target: { value: "80" } });
    expect(screen.getByTestId("order-items-total").textContent).toContain("S/ 310.00");
    await pickSeller();
    fireEvent.click(screen.getByText("review"));
    await screen.findByTestId("order-lines-preview");
    expect(screen.getByTestId("order-preview").textContent).toContain("310.00");
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const posts = fetchMock.mock.calls.filter(([url]) => url === "/api/orders/confirm");
    expect(posts).toHaveLength(1);
    const request = JSON.parse((posts[0] as unknown as [string, { body: string }])[1].body);
    expect(request.items).toEqual([
      { product_name: "Nivel laser", quantity: "1", unit_price: "150", catalog_product_id: null },
      { product_name: "Tetera", quantity: "2", unit_price: "80", catalog_product_id: null },
    ]);
    expect(request.request_key).toBe("key-1");
  });

  it("never interprets a prefilled order total as a unit price when quantity exceeds one", async () => {
    setup(true);
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.change(document.getElementById("order-quantity")!, { target: { value: "2" } });
    fireEvent.click(screen.getByText("lineMultiMode"));
    expect(value("order-item-quantity-0")).toBe("2");
    expect(value("order-item-unit-price-0")).toBe("");
    expect(screen.getByText("linePrefillTotalHint")).toBeTruthy();
    expect(screen.getByText("review").closest("button")).toBeDisabled();
  });

  it("pre-fills from the contact and its custom fields (phone stays text, quantity 1, agency Shalom)", async () => {
    setup();
    await waitFor(() => expect(value("order-price")).toBe("150"));
    expect(value("order-customer_name")).toBe("Cliente Sintetico");
    expect(value("order-phone")).toBe("900000001");
    expect(value("order-destination")).toBe("Arequipa");
    expect(value("order-quantity")).toBe("1");
  });

  it("both dropdowns are the themed Select: the department can be chosen and cleared, the list opens from the keyboard", async () => {
    setup();
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    const dept = document.getElementById("order-department")!;
    expect(dept.tagName).toBe("BUTTON"); // not a native <select>, whose popup ignores the light/dark theme
    expect(document.querySelector("select")).toBeNull();
    await choose("order-department", "Lima");
    expect(dept.textContent).toContain("Lima");
    await choose("order-department", "departmentPlaceholder");
    expect(dept.textContent).not.toContain("Lima");
    fireEvent.keyDown(document.getElementById("order-seller")!, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: sellers[0].name })).toBeTruthy();
  });

  it("cannot review until the seller is chosen and required fields are valid", async () => {
    setup();
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    expect(screen.getByText("review").closest("button")).toBeDisabled();
    await pickSeller();
    expect(screen.getByText("review").closest("button")).not.toBeDisabled();
    fireEvent.change(document.getElementById("order-price")!, { target: { value: "0" } });
    expect(screen.getByText("review").closest("button")).toBeDisabled();
  });

  it("allows editing a pre-filled value before confirming and shows the normalised preview", async () => {
    setup();
    await waitFor(() => expect(value("order-price")).toBe("150"));
    fireEvent.change(document.getElementById("order-price")!, { target: { value: "150,5" } });
    await reachPreview();
    expect(screen.getByTestId("order-preview").textContent).toContain("S/ 150.50");
    expect(screen.getByTestId("order-preview").textContent).toContain("51900000001");
  });

  it("two rapid clicks on Confirm send ONE request, carrying one stable request_key and the chosen seller", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ order_id: "o1", created: true, delivery_status: "pending" }), { status: 201 })), 20)));
    vi.stubGlobal("fetch", fetchMock);
    const { onOpenChange } = setup();
    await reachPreview();
    const confirm = screen.getByText("confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ request_key: "key-1", seller_user_id: sellers[0].id, contact_id: contact.id, product: "Nivel laser" });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("a server validation error returns to the form with the field message, and a retry reuses the same request_key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "validation_failed", errors: { destination: "required" } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ order_id: "o1", created: true, delivery_status: "held" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { onOpenChange } = setup();
    await reachPreview();
    fireEvent.click(screen.getByText("confirm"));
    await screen.findByText("errors.required");
    fireEvent.click(screen.getByText("review"));
    await screen.findByTestId("order-preview");
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const keys = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, { body: string }])[1].body).request_key);
    expect(keys).toEqual(["key-1", "key-1"]);
  });

  it("an already-confirmed order (replay) is reported as such, not as a new one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ order_id: "o1", created: false, delivery_status: "sent" }), { status: 200 })));
    const { onOpenChange } = setup();
    await reachPreview();
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith("alreadyToast", expect.anything());
  });
});
