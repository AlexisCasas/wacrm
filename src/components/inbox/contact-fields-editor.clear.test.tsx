// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { InboxContactFields } from "./contact-fields-editor";
import type { Contact } from "@/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

const h = vi.hoisted(() => ({
  canSendMessages: true,
  fields: [] as { id: string; field_name: string; field_type: string }[],
  rows: [] as { id: string; contact_id: string; custom_field_id: string; value: string | null }[],
  supabaseWrites: [] as string[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acct-1", canSendMessages: h.canSendMessages }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let op = "select";
      const run = () => {
        if (op !== "select") h.supabaseWrites.push(`${op}:${table}`);
        if (table === "contacts") {
          return { data: { id: filters.id, account_id: "acct-1", name: "n", phone: "p", email: null, company: null,
            wa_username: null, phone_optional: null, updated_at: "t0" }, error: null };
        }
        if (table === "custom_fields") return { data: h.fields, error: null };
        return { data: h.rows.filter((r) => r.contact_id === filters.contact_id), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        insert: () => { op = "insert"; return builder; },
        update: () => { op = "update"; return builder; },
        delete: () => { op = "delete"; return builder; },
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

const NAMES = ["Precio", "Precio_Producto_Respondido", "Producto", "Provincia_Respondida"];
const fetchMock = vi.fn();

function contact(id: string): Contact {
  return { id, name: `name-${id}`, phone: `phone-${id}` } as unknown as Contact;
}
function input(label: string): HTMLInputElement {
  return screen.getByText(label).closest("label")!.querySelector("input")!;
}
async function renderFor(id: string) {
  const view = render(<InboxContactFields contact={contact(id)} />);
  await screen.findByTestId("custom-fields-scroll");
  return view;
}

beforeEach(() => {
  h.canSendMessages = true;
  h.fields = NAMES.map((n) => ({ id: `f-${n}`, field_name: n, field_type: "text" }));
  h.rows = [
    { id: "a1", contact_id: "A", custom_field_id: "f-Precio", value: "170" },
    { id: "a2", contact_id: "A", custom_field_id: "f-Producto", value: "guitarra" },
    { id: "a3", contact_id: "A", custom_field_id: "f-Provincia_Respondida", value: "Lima" },
    { id: "b1", contact_id: "B", custom_field_id: "f-Precio", value: "99" },
  ];
  h.supabaseWrites = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InboxContactFields — clear all custom fields", () => {
  it("renders the clear button for editors and hides it for read-only users", async () => {
    await renderFor("A");
    expect(screen.getByText("fieldsClearAll")).toBeTruthy();
    cleanup();
    h.canSendMessages = false;
    await renderFor("A");
    expect(screen.queryByText("fieldsClearAll")).toBeNull();
  });

  it("clicking opens the confirmation and does not call the API yet", async () => {
    await renderFor("A");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    expect(await screen.findByText("fieldsClearTitle")).toBeTruthy();
    expect(screen.getByText("fieldsClearDescription")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancel changes nothing: no request, values intact", async () => {
    await renderFor("A");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    fireEvent.click(await screen.findByText("fieldsClearCancel"));
    await waitFor(() => expect(screen.queryByText("fieldsClearTitle")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input("Precio").value).toBe("170");
    expect(input("Producto").value).toBe("guitarra");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("confirm calls DELETE only for the current contact and empties every input", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await renderFor("A");
    expect(input("Provincia_Respondida").value).toBe("Lima");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    fireEvent.click(await screen.findByText("fieldsClearConfirm"));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("fieldsClearedToast"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/contacts/A/custom-values", { method: "DELETE" });
    for (const n of NAMES) expect(input(n).value).toBe("");
    // Field definitions are still rendered; nothing written through the browser client.
    for (const n of NAMES) expect(screen.getByText(n)).toBeTruthy();
    expect(h.supabaseWrites).toEqual([]);
    expect(screen.queryByText("fieldsClearTitle")).toBeNull();
  });

  it("contact B keeps its values (opened after clearing A)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { rerender } = await renderFor("A");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    fireEvent.click(await screen.findByText("fieldsClearConfirm"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    rerender(<InboxContactFields contact={contact("B")} />);
    await waitFor(() => expect(input("Precio").value).toBe("99"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("API failure: error toast, no success, UI keeps the real values", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await renderFor("A");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    fireEvent.click(await screen.findByText("fieldsClearConfirm"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("fieldsClearError"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(input("Precio").value).toBe("170");
    expect(input("Producto").value).toBe("guitarra");
  });

  it("network failure is treated as an error too", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await renderFor("A");
    fireEvent.click(screen.getByText("fieldsClearAll"));
    fireEvent.click(await screen.findByText("fieldsClearConfirm"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("fieldsClearError"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(input("Precio").value).toBe("170");
  });

  it("regression: Save fields still writes only the edited value through the existing path", async () => {
    await renderFor("A");
    fireEvent.change(input("Precio"), { target: { value: "180" } });
    fireEvent.click(screen.getByText("fieldsSaveCustom"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("fieldsSaved"));
    expect(h.supabaseWrites).toEqual(["update:contact_custom_values"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
