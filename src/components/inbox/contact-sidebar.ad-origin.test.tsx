// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

import { ContactSidebar } from "./contact-sidebar";
import type { Contact } from "@/types";

// The REAL ContactSidebar with "Origen del cliente" mounted inside it: exactly one section per contact, whatever the order the origin reads come back in.

const LABELS: Record<string, string> = {
  originTitle: "ORIGEN DEL CLIENTE", originMetaAd: "Publicidad en Meta", originAd: "Anuncio", originDetail: "Detalle", originEntry: "Entrada",
  originEntryValue: "Click a WhatsApp", originPlatform: "Plataforma", originViewAd: "Ver anuncio", originNone: "Sin atribución de anuncio",
  originFacebook: "Facebook", originInstagram: "Instagram",
};
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => LABELS[key] ?? key, useLocale: () => "es" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct-1", canSendMessages: false, canEditSettings: false }) }));

type Row = { headline: string | null; body?: string | null; source_url: string | null } | null;
const h = vi.hoisted(() => ({ pending: new Map<string, (row: unknown) => void>() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const f: Record<string, string> = {};
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "in", "is", "neq", "gte", "lte", "ilike"]) b[m] = () => b;
      b.eq = (k: string, v: string) => ((f[k] = v), b);
      b.maybeSingle = () =>
        table === "contact_ad_attributions"
          ? new Promise((resolve) => h.pending.set(f.contact_id, (row) => resolve({ data: row, error: null })))
          : Promise.resolve({ data: null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  }),
}));
vi.mock("@/lib/contacts/tag-api", () => ({ addContactTag: vi.fn(), deleteContactTag: vi.fn(), createTag: vi.fn(), TagApiError: class extends Error {} }));

const contact = (id: string): Contact =>
  ({ id, user_id: "u", account_id: "acct-1", phone: "+15550000000", name: `Contacto ${id}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", tags: [] }) as Contact;

const answer = async (contactId: string, row: Row) => {
  await waitFor(() => expect(h.pending.has(contactId)).toBe(true));
  await act(async () => { h.pending.get(contactId)!(row); });
};
const sections = () => screen.queryAllByTestId("contact-ad-origin");

beforeEach(() => h.pending.clear());
afterEach(() => cleanup());

describe("ContactSidebar: one ORIGEN DEL CLIENTE section per contact", () => {
  it("renders exactly one section, with the ad", async () => {
    render(<ContactSidebar contact={contact("a")} />);
    await answer("a", { headline: "Corporación Lorteg del Perú SAC", body: "Taladro inalámbrico 20V", source_url: null });
    expect(sections()).toHaveLength(1);
    expect(screen.getAllByText("ORIGEN DEL CLIENTE")).toHaveLength(1);
    expect(screen.getAllByText(/Publicidad en Meta/)).toHaveLength(1);
    expect(screen.queryByText("Sin atribución de anuncio")).toBeNull();
  });

  it("A (ad) -> B (ad) -> C (none), with A's and B's reads answered LAST: only C's state is ever shown, once", async () => {
    const { rerender } = render(<ContactSidebar contact={contact("a")} />);
    rerender(<ContactSidebar contact={contact("b")} />);
    rerender(<ContactSidebar contact={contact("c")} />);
    await answer("c", null);
    expect(sections()).toHaveLength(1);
    expect(screen.getByText("Sin atribución de anuncio")).toBeTruthy();
    // Late answers of the previous contacts arrive now.
    await answer("a", { headline: "Anuncio de A", body: "Taladro", source_url: null });
    await answer("b", { headline: "Anuncio de B", body: "Lavadora", source_url: null });
    expect(sections()).toHaveLength(1);
    expect(screen.getByText("Sin atribución de anuncio")).toBeTruthy();
    expect(screen.queryByText(/Publicidad en Meta|Taladro|Lavadora|Anuncio de/)).toBeNull();
  });

  it("A -> B: B's ad replaces A's, one section, even when A answers after B", async () => {
    const { rerender } = render(<ContactSidebar contact={contact("a")} />);
    rerender(<ContactSidebar contact={contact("b")} />);
    await answer("b", { headline: "Corporación Lorteg del Perú SAC", body: "Lavadora industrial 15 kg", source_url: null });
    await answer("a", { headline: "Corporación Lorteg del Perú SAC", body: "Taladro inalámbrico 20V", source_url: null });
    expect(sections()).toHaveLength(1);
    expect(screen.getByText(/Lavadora industrial 15 kg/)).toBeTruthy();
    expect(screen.queryByText(/Taladro/)).toBeNull();
  });
});
