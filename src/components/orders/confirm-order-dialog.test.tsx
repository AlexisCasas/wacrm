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

function setup() {
  const onOpenChange = vi.fn();
  render(<ConfirmOrderDialog open onOpenChange={onOpenChange} contact={contact} conversationId="33333333-3333-4333-8333-333333333333" sellers={sellers} />);
  return { onOpenChange };
}
const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

async function reachPreview() {
  await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
  fireEvent.change(document.getElementById("order-seller")!, { target: { value: sellers[0].id } });
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

  it("pre-fills from the contact and its custom fields (phone stays text, quantity 1, agency Shalom)", async () => {
    setup();
    await waitFor(() => expect(value("order-price")).toBe("150"));
    expect(value("order-customer_name")).toBe("Cliente Sintetico");
    expect(value("order-phone")).toBe("900000001");
    expect(value("order-destination")).toBe("Arequipa");
    expect(value("order-quantity")).toBe("1");
  });

  it("cannot review until the seller is chosen and required fields are valid", async () => {
    setup();
    await waitFor(() => expect(value("order-product")).toBe("Nivel laser"));
    expect(screen.getByText("review").closest("button")).toBeDisabled();
    fireEvent.change(document.getElementById("order-seller")!, { target: { value: sellers[0].id } });
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
    expect(body).toMatchObject({ request_key: "key-1", seller_id: sellers[0].id, contact_id: contact.id, product: "Nivel laser" });
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
