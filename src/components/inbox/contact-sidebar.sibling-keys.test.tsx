// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { ContactSidebar } from "./contact-sidebar";
import type { Contact } from "@/types";

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k, useLocale: () => "es" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct-1", canSendMessages: false, canEditSettings: false }) }));
const rows: Record<string, unknown> = { a: { headline: "InkaClick", source_url: null }, b: null, c: { headline: "InkaClick", source_url: "https://fb.me/x" } };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const f: Record<string, string> = {}; const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "in", "is"]) b[m] = () => b;
      b.eq = (k: string, v: string) => ((f[k] = v), b);
      b.maybeSingle = () => Promise.resolve({ data: table === "contact_ad_attributions" ? (rows[f.contact_id] ?? null) : null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  }),
}));
vi.mock("@/lib/contacts/tag-api", () => ({ addContactTag: vi.fn(), deleteContactTag: vi.fn(), createTag: vi.fn(), TagApiError: class extends Error {} }));
const contact = (id: string) => ({ id, user_id: "u", account_id: "acct-1", phone: "+1555", name: id, created_at: "x", updated_at: "x", tags: [] }) as unknown as Contact;
afterEach(() => cleanup());

// Regression: ContactAdOrigin and ContactAutomationToggle are siblings. Both used `key={contact.id}`; with two siblings of the SAME key React drops one of the
// old fibers from its bookkeeping when the key changes, never removes its DOM, and every contact switch left one more stale "ORIGEN DEL CLIENTE" block behind
// (the reads must have FINISHED before the switch, which is why a switch during loading did not show it).
describe("ContactSidebar: sibling keys are unique, so switching contacts never accumulates origin sections", () => {
  it("keeps exactly one section after every switch (origins already loaded) and emits no duplicate-key warning", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<ContactSidebar contact={contact("a")} />);
    await waitFor(() => expect(screen.getAllByTestId("contact-ad-origin")).toHaveLength(1));
    for (const id of ["b", "c", "a", "b"]) {
      await act(async () => { rerender(<ContactSidebar contact={contact(id)} />); });
      await waitFor(() => expect(screen.getAllByTestId("contact-ad-origin").length).toBeGreaterThan(0));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(screen.getAllByTestId("contact-ad-origin")).toHaveLength(1);
      expect(screen.getAllByText("originTitle")).toHaveLength(1);
    }
    // The last contact (b) has no attribution: only that state is visible, never an ad block next to "no attribution".
    expect(screen.getByText("originNone")).toBeTruthy();
    expect(screen.queryByText("originMetaAd")).toBeNull();
    expect(err.mock.calls.filter((c) => String(c[0]).includes("same key"))).toHaveLength(0);
    err.mockRestore();
  });
});
