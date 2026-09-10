import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P0 — BLOQUEO INTERNO DE CONTACTOS. A blocked contact's name must
// never keep syncing from inbound Meta profile data — a blocked
// inbound is a hard stop, not "mostly normal processing." Everything
// else about findOrCreateContact (dedupe, create, race recovery) is
// pre-existing behavior exercised indirectly by the webhook's own
// test suite; this file only proves the new blocked-guard branch.

const h = vi.hoisted(() => ({
  findExistingContact: vi.fn(),
  isUniqueViolation: vi.fn(() => false),
}));

vi.mock("@/lib/contacts/dedupe", () => ({
  findExistingContact: h.findExistingContact,
  isUniqueViolation: h.isUniqueViolation,
}));

import { findOrCreateContact } from "./find-or-create";

function fakeDb(updateCalls: { id: string; payload: Record<string, unknown> }[]): SupabaseClient {
  return {
    from: () => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updateCalls.push({ id, payload });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  h.findExistingContact.mockReset();
  h.isUniqueViolation.mockReturnValue(false);
});

describe("findOrCreateContact — blocked contact name-sync guard", () => {
  it("does NOT update the name when the existing contact is blocked, even if Meta sent a different name", async () => {
    h.findExistingContact.mockResolvedValue({
      id: "contact-1",
      name: "Old Name",
      blocked: true,
    });
    const updateCalls: { id: string; payload: Record<string, unknown> }[] = [];

    const result = await findOrCreateContact(
      fakeDb(updateCalls),
      "acct-1",
      "owner-1",
      "+15551234567",
      "New Name From Meta",
    );

    expect(updateCalls).toHaveLength(0);
    expect(result?.contact.name).toBe("Old Name");
    expect(result?.wasCreated).toBe(false);
  });

  it("still updates the name for a NON-blocked existing contact (no regression)", async () => {
    h.findExistingContact.mockResolvedValue({
      id: "contact-1",
      name: "Old Name",
      blocked: false,
    });
    const updateCalls: { id: string; payload: Record<string, unknown> }[] = [];

    await findOrCreateContact(
      fakeDb(updateCalls),
      "acct-1",
      "owner-1",
      "+15551234567",
      "New Name From Meta",
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      id: "contact-1",
      payload: { name: "New Name From Meta" },
    });
  });

  it("still updates the name when blocked is simply absent (undefined) — pre-migration rows", async () => {
    h.findExistingContact.mockResolvedValue({
      id: "contact-1",
      name: "Old Name",
    });
    const updateCalls: { id: string; payload: Record<string, unknown> }[] = [];

    await findOrCreateContact(
      fakeDb(updateCalls),
      "acct-1",
      "owner-1",
      "+15551234567",
      "New Name From Meta",
    );

    expect(updateCalls).toHaveLength(1);
  });
});

// P1 Fase 2B (docs/P1_DUPLICATE_CHATS_AUDIT.md section Q) — SECOND
// BARRIER. findOrCreateContact must refuse an empty/non-normalizable
// phone itself, regardless of what the caller passed in — a caller bug
// (or a future caller nobody hardened yet) must not be able to insert
// contacts.phone = '', which is exactly how one inbound message could
// fragment into a brand-new contact + conversation every time (the
// "Juor Nuevo" incident).
function fakeDbWithInsertTracking(insertCalls: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        insertCalls.push(row);
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "new-contact", ...row }, error: null }),
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
}

describe("findOrCreateContact — second barrier: refuses an empty/non-normalizable phone", () => {
  beforeEach(() => {
    // No existing contact for any of these — if the barrier didn't
    // exist, execution would fall through to the INSERT branch below.
    h.findExistingContact.mockResolvedValue(null);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["no digits at all", "unknown"],
  ])("returns null and never inserts for phone = %s (%p)", async (_label, phone) => {
    const insertCalls: Record<string, unknown>[] = [];
    const result = await findOrCreateContact(
      fakeDbWithInsertTracking(insertCalls),
      "acct-1",
      "owner-1",
      phone,
      "Some Name",
    );

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
    // findExistingContact must never even be consulted with a phone
    // that can't normalize — there is nothing to look up.
    expect(h.findExistingContact).not.toHaveBeenCalled();
  });

  it("still creates a contact normally when the phone DOES normalize", async () => {
    const insertCalls: Record<string, unknown>[] = [];
    const result = await findOrCreateContact(
      fakeDbWithInsertTracking(insertCalls),
      "acct-1",
      "owner-1",
      "+1 (555) 123-4567",
      "Real Person",
    );

    expect(result?.wasCreated).toBe(true);
    expect(insertCalls).toHaveLength(1);
    // Persists the NORMALIZED value, not the raw caller-supplied string.
    expect(insertCalls[0]).toMatchObject({ phone: "15551234567" });
    expect(h.findExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      "acct-1",
      "15551234567",
    );
  });
});
