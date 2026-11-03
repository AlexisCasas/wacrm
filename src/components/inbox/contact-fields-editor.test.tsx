// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { InboxContactFields } from "./contact-fields-editor";
import type { Contact } from "@/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Row = { id: string; contact_id: string; custom_field_id: string; value: string | null };

const h = vi.hoisted(() => ({
  canSendMessages: true,
  fields: [] as { id: string; field_name: string; field_type: string }[],
  rows: [] as { id: string; contact_id: string; custom_field_id: string; value: string | null }[],
  valueQueries: [] as string[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as { contact_id?: string }[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acct-1", canSendMessages: h.canSendMessages }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let op: "select" | "insert" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const run = () => {
        if (table === "contacts") {
          const id = filters.id as string;
          return { data: { id, account_id: "acct-1", name: `name-${id}`, phone: `phone-${id}`,
            email: null, company: null, wa_username: null, phone_optional: null,
            updated_at: "t0" }, error: null };
        }
        if (table === "custom_fields") return { data: h.fields, error: null };
        if (op === "insert") {
          h.inserts.push(payload);
          return { data: { id: "new", custom_field_id: payload.custom_field_id, value: payload.value }, error: null };
        }
        if (op === "update") {
          h.updates.push({ contact_id: filters.contact_id as string });
          return { data: { id: filters.id, custom_field_id: filters.custom_field_id, value: payload.value }, error: null };
        }
        h.valueQueries.push(filters.contact_id as string);
        return { data: h.rows.filter((r) => r.contact_id === filters.contact_id), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        insert: (p: Record<string, unknown>) => { op = "insert"; payload = p; return builder; },
        update: (p: Record<string, unknown>) => { op = "update"; payload = p; return builder; },
        eq: (k: string, v: unknown) => { filters[k] = v; return builder; },
        is: () => builder,
        maybeSingle: () => Promise.resolve(run()),
        single: () => Promise.resolve(run()),
        then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      };
      return builder;
    },
  }),
}));

const NAMES = ["Agencia", "Cantidad", "Departamento", "Descripción de Pedido", "Destino", "DNI", "Precio", "Producto"];

function contact(id: string): Contact {
  return { id, name: `name-${id}`, phone: `phone-${id}` } as unknown as Contact;
}
function row(contactId: string, fieldName: string, value: string): Row {
  return { id: `${contactId}-${fieldName}`, contact_id: contactId, custom_field_id: `f-${fieldName}`, value };
}
function input(label: string): HTMLInputElement {
  return screen.getByText(label).closest("label")!.querySelector("input")!;
}

beforeEach(() => {
  h.canSendMessages = true;
  h.fields = NAMES.map((n) => ({ id: `f-${n}`, field_name: n, field_type: "text" }));
  h.rows = [
    row("angelo", "Destino", "Cajamarca"),
    row("angelo", "Precio", "115"),
    row("angelo", "Producto", "paquete de 100 discos"),
    row("keyler", "Destino", "Lima"),
    row("keyler", "Precio", "189"),
    row("keyler", "Producto", "Amoladora"),
  ];
  h.valueQueries = [];
  h.inserts = [];
  h.updates = [];
});
afterEach(cleanup);

async function renderFor(id: string) {
  const view = render(<InboxContactFields contact={contact(id)} />);
  await screen.findByTestId("custom-fields-scroll");
  return view;
}

describe("InboxContactFields — per-contact custom values", () => {
  it("shows all account fields, empty when the contact has no value", async () => {
    await renderFor("angelo");
    for (const n of NAMES) expect(screen.getByText(n)).toBeTruthy();
    expect(input("Destino").value).toBe("Cajamarca");
    expect(input("Precio").value).toBe("115");
    expect(input("Producto").value).toBe("paquete de 100 discos");
    for (const n of ["Agencia", "Cantidad", "Departamento", "Descripción de Pedido", "DNI"]) {
      expect(input(n).value).toBe("");
    }
  });

  it("queries values only for the selected contact", async () => {
    await renderFor("angelo");
    expect(h.valueQueries).toEqual(["angelo"]);
  });

  it("switching Angelo → Keyler (same component instance) never shows Angelo's values", async () => {
    const { rerender } = await renderFor("angelo");
    expect(input("Precio").value).toBe("115");

    rerender(<InboxContactFields contact={contact("keyler")} />);
    // Immediately after the switch no field of the previous contact is rendered.
    expect(screen.queryByDisplayValue("115")).toBeNull();
    expect(screen.queryByDisplayValue("paquete de 100 discos")).toBeNull();
    expect(screen.queryByDisplayValue("Cajamarca")).toBeNull();

    await waitFor(() => expect(input("Precio").value).toBe("189"));
    expect(input("Producto").value).toBe("Amoladora");
    expect(input("Destino").value).toBe("Lima");
    expect(input("DNI").value).toBe("");
    expect(h.valueQueries).toEqual(["angelo", "keyler"]);
  });

  it("renders a newly created custom field with no code change", async () => {
    h.fields = [...h.fields, { id: "f-Tipo", field_name: "Tipo de entrega", field_type: "text" }];
    await renderFor("angelo");
    expect(input("Tipo de entrega").value).toBe("");
  });

  it("puts the custom field list in a height-limited scroll container", async () => {
    await renderFor("angelo");
    const box = screen.getByTestId("custom-fields-scroll");
    expect(box.className).toContain("max-h-");
    expect(box.className).toContain("overflow-y-auto");
    // Scroll must chain to the sidebar once the list hits its edge.
    expect(box.className).not.toContain("overscroll");
    expect(box.querySelectorAll("input").length).toBe(NAMES.length);
  });

  it("search filters by field name and keeps the contact's value", async () => {
    await renderFor("keyler");
    fireEvent.change(screen.getByLabelText("fieldsSearch"), { target: { value: "precio" } });
    expect(screen.queryByText("Producto")).toBeNull();
    expect(input("Precio").value).toBe("189");
  });

  it("saves edits with contact_id of the current contact only", async () => {
    await renderFor("angelo");
    fireEvent.change(input("Precio"), { target: { value: "120" } });
    fireEvent.change(input("DNI"), { target: { value: "99" } });
    fireEvent.click(screen.getByText("fieldsSaveCustom"));
    await waitFor(() => expect(h.inserts.length).toBe(1));
    expect(h.updates).toEqual([{ contact_id: "angelo" }]);
    expect(h.inserts[0]).toMatchObject({ contact_id: "angelo", custom_field_id: "f-DNI", value: "99" });
    expect(JSON.stringify([h.updates, h.inserts])).not.toContain("keyler");
  });

  it("viewer sees values but cannot edit or save", async () => {
    h.canSendMessages = false;
    await renderFor("angelo");
    expect(input("Precio").value).toBe("115");
    expect(input("Precio").disabled).toBe(true);
    expect(screen.queryByText("fieldsSaveCustom")).toBeNull();
  });

  it("agent with permission can edit and save", async () => {
    await renderFor("angelo");
    expect(input("Precio").disabled).toBe(false);
    fireEvent.change(input("Precio"), { target: { value: "120" } });
    expect((screen.getByText("fieldsSaveCustom").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
