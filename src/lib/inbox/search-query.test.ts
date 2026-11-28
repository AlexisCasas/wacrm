import { describe, expect, it } from "vitest";
import {
  MAX_ORDER_MATCH_CONTACTS,
  orderPhoneCandidates,
  orderPhoneSearchWindows,
  pickOrderContactIds,
  escapeLike,
  exactPhoneCandidates,
  matchesInboxSearch,
  phoneDigitsFromTerm,
  planInboxSearch,
  quotePostgrestValue,
} from "./search-query";

const conv = (name: string, phone: string | null, last = "", username: string | null = null) =>
  ({
    last_message_text: last,
    contact: { name, phone, wa_username: username },
  }) as Parameters<typeof matchesInboxSearch>[0];

describe("phone normalization", () => {
  it.each([
    ["987654321", "987654321"],
    ["+51987654321", "51987654321"],
    ["+51 987 654 321", "51987654321"],
    ["987-654-321", "987654321"],
    ["(51) 987 654 321", "51987654321"],
    ["0051 987 654 321", "51987654321"],
    ["987.654.321", "987654321"],
  ])("%s -> %s", (typed, digits) => {
    expect(phoneDigitsFromTerm(typed)).toBe(digits);
  });

  it("does not treat text or mixed text as a phone", () => {
    expect(phoneDigitsFromTerm("maria")).toBeNull();
    expect(phoneDigitsFromTerm("pedido 123456")).toBeNull();
    expect(phoneDigitsFromTerm("+")).toBeNull();
  });
});

describe("exact vs fragment", () => {
  it("national 9-digit mobile matches exactly, with and without country code", () => {
    const p = planInboxSearch("987 654 321");
    expect(p.phoneExact).toEqual(["51987654321", "987654321"]);
    expect(p.phoneFragment).toBeNull();
    expect(p.contactOrFilter).toContain("phone_normalized.in.(51987654321,987654321)");
    expect(p.contactOrFilter).not.toContain("phone.ilike");
  });

  it("+51 and plain forms produce the same exact candidates", () => {
    expect(planInboxSearch("+51 987-654-321").phoneExact).toEqual(
      planInboxSearch("987654321").phoneExact,
    );
  });

  it("never uses a suffix match for a complete number", () => {
    const p = planInboxSearch("+51987654321");
    expect(p.contactOrFilter).not.toMatch(/phone\.ilike/);
    expect(matchesInboxSearch(conv("A", "51987654321"), p)).toBe(true);
    // Same last 8 digits, different number: must NOT match.
    expect(matchesInboxSearch(conv("B", "51887654321"), p)).toBe(false);
    expect(matchesInboxSearch(conv("C", "510987654321"), p)).toBe(false);
  });

  it("other full international numbers are exact", () => {
    expect(exactPhoneCandidates("5491155551234")).toEqual(["5491155551234"]);
  });

  it("6-8 digit runs are substring fragments; <6 stay plain text", () => {
    const frag = planInboxSearch("654 321");
    expect(frag.phoneFragment).toBe("654321");
    expect(frag.contactOrFilter).toContain('phone.ilike."%654321%"');
    const short = planInboxSearch("1234");
    expect(short.phoneFragment).toBeNull();
    expect(short.phoneExact).toEqual([]);
    expect(short.contactOrFilter).toContain('phone.ilike."%1234%"');
  });
});

describe("escaping", () => {
  it("quotes PostgREST reserved characters", () => {
    expect(quotePostgrestValue('a,b(c):d.e')).toBe('"a,b(c):d.e"');
    expect(quotePostgrestValue('say "hi"\\')).toBe('"say \\"hi\\"\\\\"');
  });

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("a name with commas/parentheses cannot add or break filters", () => {
    const p = planInboxSearch("Pérez, Juan (VIP)");
    // exactly three predicates: name, username, phone
    const parts = p.contactOrFilter.split(/,(?=(?:name|wa_username|phone)\.)/);
    expect(parts).toHaveLength(3);
    expect(p.contactOrFilter).toContain('name.ilike."%Pérez, Juan (VIP)%"');
  });

  it("injection attempt stays inside the quoted value", () => {
    const p = planInboxSearch('x",phone.eq.1,name.ilike."');
    expect(p.contactOrFilter).toContain('name.ilike."%x\\",phone.eq.1,name.ilike.\\"%"');
  });
});

describe("in-memory predicate (mirrors the DB)", () => {
  it("name with accents", () => {
    const p = planInboxSearch("José");
    expect(matchesInboxSearch(conv("José Ñandú", "51900000001"), p)).toBe(true);
    expect(matchesInboxSearch(conv("Maria", "51900000002"), p)).toBe(false);
  });

  it("special characters are literal", () => {
    expect(matchesInboxSearch(conv("A&B (Lima), SAC", null), planInboxSearch("a&b (lima), sac"))).toBe(true);
  });

  it("username, last message and no-match", () => {
    expect(matchesInboxSearch(conv("X", null, "", "juanp"), planInboxSearch("juanp"))).toBe(true);
    expect(matchesInboxSearch(conv("X", null, "quiero el pedido"), planInboxSearch("pedido"))).toBe(true);
    expect(matchesInboxSearch(conv("X", "51900000001"), planInboxSearch("zzzz"))).toBe(false);
  });

  it("phone-less contact never matches a number", () => {
    expect(matchesInboxSearch(conv("X", null), planInboxSearch("987654321"))).toBe(false);
  });
});

describe("order phone lookup (FIX 02)", () => {
  it("only complete numbers consult orders, with the same candidates as contacts", () => {
    expect(orderPhoneCandidates(planInboxSearch("+51 954 953 878"))).toEqual(["51954953878", "954953878"]);
    expect(orderPhoneCandidates(planInboxSearch("954953878"))).toEqual(["51954953878", "954953878"]);
    expect(orderPhoneCandidates(planInboxSearch("953 878"))).toEqual([]);
    expect(orderPhoneCandidates(planInboxSearch("1234"))).toEqual([]);
    expect(orderPhoneCandidates(planInboxSearch("maria"))).toEqual([]);
  });

  it("dedupes contacts across orders, drops nulls and keeps newest-first order", () => {
    const r = pickOrderContactIds([{ contact_id: "a" }, { contact_id: null }, { contact_id: "b" }, { contact_id: "a" }], 1000);
    expect(r).toEqual({ contactIds: ["a", "b"], truncated: false });
  });

  it("caps at 100 contacts and reports truncation; a full page also reports it", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ contact_id: `c${i}` }));
    const r = pickOrderContactIds(rows, 1000);
    expect(r.contactIds).toHaveLength(MAX_ORDER_MATCH_CONTACTS);
    expect(r.truncated).toBe(true);
    expect(pickOrderContactIds(Array.from({ length: 5 }, () => ({ contact_id: "z" })), 5).truncated).toBe(true);
  });

  it("an order-matched conversation passes the in-memory filter; others still need a real match", () => {
    const plan = planInboxSearch("+51 954 953 878");
    const c = { id: "k1", last_message_text: "", contact: { name: "Solo", phone: "", wa_username: "u" } } as never;
    expect(matchesInboxSearch(c, plan)).toBe(false);
    expect(matchesInboxSearch(c, plan, new Set(["k1"]))).toBe(true);
    expect(matchesInboxSearch(c, plan, new Set(["other"]))).toBe(false);
  });
});


describe("progressive order-phone windows", () => {
  it("searches 0-15, 15-30, 30-90, 90-180, 180-365, then older history", () => {
    const now = Date.UTC(2026, 10, 28, 12, 0, 0);
    expect(orderPhoneSearchWindows(now)).toEqual([
      { after: "2026-11-13T12:00:00.000Z", before: null },
      { after: "2026-10-29T12:00:00.000Z", before: "2026-11-13T12:00:00.000Z" },
      { after: "2026-08-30T12:00:00.000Z", before: "2026-10-29T12:00:00.000Z" },
      { after: "2026-06-01T12:00:00.000Z", before: "2026-08-30T12:00:00.000Z" },
      { after: "2025-11-28T12:00:00.000Z", before: "2026-06-01T12:00:00.000Z" },
      { after: null, before: "2025-11-28T12:00:00.000Z" },
    ]);
  });
});
