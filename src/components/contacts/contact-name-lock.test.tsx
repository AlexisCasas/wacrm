// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { ContactForm } from "./contact-form";
import { ContactDetailView } from "./contact-detail-view";
import type { Contact } from "@/types";

// FIX 03 — manual edits from the Contacts screens save the name together with its lock,
// reject an emptied name, and leave the name alone when only other fields change.

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("@/lib/date-locale", () => ({ useIntlLocaleTag: () => "en-US", useDateFnsLocale: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

const h = vi.hoisted(() => ({
  contactRow: { id: "c1", account_id: "acct-1", name: "Perfil WhatsApp", phone: "51900000001", email: null, company: null, name_locked: false, phone_optional: false } as Record<string, unknown>,
  updates: [] as { table: string; payload: Record<string, unknown> }[],
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct-1", defaultCurrency: "PEN", canSendMessages: true }) }));
// The real createClient() is a singleton; a fresh object per call would re-trigger the detail view's fetch effects.
const clientRef = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => (clientRef.value ??= {
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "u1" } } } }) },
    from: (table: string) => {
      let op = "select"; let payload: Record<string, unknown> = {};
      const result = () => {
        if (op === "update") h.updates.push({ table, payload });
        if (table === "contacts" && op === "select") return { data: h.contactRow, error: null };
        return { data: op === "select" ? [] : null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b, order: () => b, eq: () => b, in: () => b, is: () => b, limit: () => b, delete: () => b,
        insert: (p: Record<string, unknown>) => { op = "insert"; payload = p; return b; },
        update: (p: Record<string, unknown>) => { op = "update"; payload = p; return b; },
        single: () => Promise.resolve(result()), maybeSingle: () => Promise.resolve(result()),
        then: (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res),
      };
      return b;
    },
  }),
}));

const contact = h.contactRow as unknown as Contact;
const contactUpdates = () => h.updates.filter((u) => u.table === "contacts");

beforeEach(() => { h.updates = []; vi.mocked(toast.error).mockClear(); });
afterEach(cleanup);

describe("ContactForm (edit) — name lock", () => {
  async function open() {
    render(<ContactForm open onOpenChange={() => {}} contact={contact} onSaved={() => {}} />);
    return (await screen.findByDisplayValue("Perfil WhatsApp")) as HTMLInputElement;
  }
  const submit = () => fireEvent.click(document.querySelector('button[type="submit"]')!);

  it("a changed name is sent with name_locked=true in the same update", async () => {
    const name = await open();
    fireEvent.change(name, { target: { value: "  Cliente Keyler " } });
    submit();
    await waitFor(() => expect(contactUpdates()).toHaveLength(1));
    expect(contactUpdates()[0].payload).toMatchObject({ name: "Cliente Keyler", name_locked: true });
  });

  it("changing only the company leaves the name and the lock out of the update", async () => {
    await open();
    fireEvent.change(document.getElementById("cf-company")!, { target: { value: "ACME" } });
    submit();
    await waitFor(() => expect(contactUpdates()).toHaveLength(1));
    expect(contactUpdates()[0].payload).toMatchObject({ company: "ACME" });
    expect("name" in contactUpdates()[0].payload).toBe(false);
    expect("name_locked" in contactUpdates()[0].payload).toBe(false);
  });

  it("an emptied name is rejected: nothing is written", async () => {
    const name = await open();
    fireEvent.change(name, { target: { value: "   " } });
    submit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nameRequired"));
    expect(contactUpdates()).toHaveLength(0);
  });
});

describe("ContactDetailView — name lock", () => {
  async function open() {
    render(<ContactDetailView open onOpenChange={() => {}} contactId="c1" onUpdated={() => {}} />);
    return (await screen.findByDisplayValue("Perfil WhatsApp")) as HTMLInputElement;
  }
  const save = () => fireEvent.click(screen.getByText("saveChangesBtn"));

  it("a changed name is sent with name_locked=true in the same update", async () => {
    const name = await open();
    fireEvent.change(name, { target: { value: "Cliente Keyler" } });
    save();
    await waitFor(() => expect(contactUpdates()).toHaveLength(1));
    expect(contactUpdates()[0].payload).toMatchObject({ name: "Cliente Keyler", name_locked: true });
  });

  it("saving other details without touching the name does not lock it", async () => {
    await open();
    fireEvent.change(screen.getByDisplayValue("51900000001"), { target: { value: "51900000001" } });
    const company = document.querySelectorAll("input");
    expect(company.length).toBeGreaterThan(0);
    save();
    await waitFor(() => expect(contactUpdates()).toHaveLength(1));
    expect("name" in contactUpdates()[0].payload).toBe(false);
    expect("name_locked" in contactUpdates()[0].payload).toBe(false);
  });

  it("an emptied name is rejected: nothing is written", async () => {
    const name = await open();
    fireEvent.change(name, { target: { value: "" } });
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("toastNameRequired"));
    expect(contactUpdates()).toHaveLength(0);
  });
});
