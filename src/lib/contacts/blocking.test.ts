import { describe, it, expect } from "vitest";
import { assertContactCanReceive, ContactBlockedError } from "./blocking";

function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => result,
          }),
        }),
      }),
    }),
  };
}

describe("assertContactCanReceive", () => {
  it("throws ContactBlockedError when the contact is blocked", async () => {
    const db = fakeDb({ data: { blocked: true }, error: null });
    await expect(assertContactCanReceive(db, "acct-1", "ct-1")).rejects.toBeInstanceOf(
      ContactBlockedError,
    );
  });

  it("resolves silently when the contact is not blocked", async () => {
    const db = fakeDb({ data: { blocked: false }, error: null });
    await expect(assertContactCanReceive(db, "acct-1", "ct-1")).resolves.toBeUndefined();
  });

  it("resolves silently when no row is found — the caller's own lookup owns that error", async () => {
    const db = fakeDb({ data: null, error: null });
    await expect(assertContactCanReceive(db, "acct-1", "ct-1")).resolves.toBeUndefined();
  });

  it("throws a generic Error (not ContactBlockedError) on a query error", async () => {
    const db = fakeDb({ data: null, error: { message: "connection reset" } });
    await expect(assertContactCanReceive(db, "acct-1", "ct-1")).rejects.toThrow(
      /connection reset/,
    );
    await expect(assertContactCanReceive(db, "acct-1", "ct-1")).rejects.not.toBeInstanceOf(
      ContactBlockedError,
    );
  });

  it("ContactBlockedError carries a stable machine code", () => {
    const err = new ContactBlockedError();
    expect(err.code).toBe("contact_blocked");
    expect(err).toBeInstanceOf(Error);
  });
});
