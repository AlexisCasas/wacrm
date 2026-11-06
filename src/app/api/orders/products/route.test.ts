import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requireRole = vi.fn();
const settingsRead = vi.fn();
const productsRead = vi.fn();
const queriedAccounts = vi.fn();
const queriedProducts = vi.fn();

vi.mock("@/lib/auth/account", () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  toErrorResponse: (error: Error) => new Response(JSON.stringify({ error: error.message }), { status: 403 }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => table === "order_integration_settings"
      ? { select: () => ({ eq: (...args: unknown[]) => {
        queriedAccounts(...args);
        return { maybeSingle: settingsRead };
      } }) }
      : { select: () => {
        const chain = {
          eq: (...args: unknown[]) => { queriedProducts(...args); return chain; },
          ilike: () => chain,
          order: () => chain,
          limit: () => productsRead(),
        };
        return chain;
      } },
  }),
}));

import { GET } from "./route";

const query = (q: string) => GET(new Request("http://example.invalid/api/orders/products?q=" + encodeURIComponent(q)));

beforeEach(() => {
  requireRole.mockReset();
  settingsRead.mockReset();
  productsRead.mockReset();
  queriedAccounts.mockReset();
  queriedProducts.mockReset();
  requireRole.mockResolvedValue({ accountId: ACCOUNT });
  settingsRead.mockResolvedValue({ data: { confirm_enabled: true, multiproduct_enabled: false }, error: null });
  productsRead.mockResolvedValue({ data: [{ id: "p-1", display_name: "Tetera", active: true }], error: null });
});

describe("GET /api/orders/products", () => {
  it("requires the role of an agent and account from the session", async () => {
    requireRole.mockRejectedValue(new Error("forbidden"));
    expect((await query("Tetera")).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent");
    expect(queriedAccounts).not.toHaveBeenCalled();
  });

  it("does not expose the catalog when multi-items are switched off", async () => {
    const r = await query("Tetera");
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("multiproduct_disabled");
    expect(queriedAccounts).toHaveBeenCalledWith("account_id", ACCOUNT);
    expect(queriedProducts).not.toHaveBeenCalled();
  });

  it("selects only active products in the authenticated account, with no tenant override", async () => {
    settingsRead.mockResolvedValue({ data: { confirm_enabled: true, multiproduct_enabled: true }, error: null });
    const r = await GET(new Request("http://example.invalid/api/orders/products?q=Tetera&account_id=other"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ products: [{ id: "p-1", display_name: "Tetera", active: true }] });
    expect(queriedProducts).toHaveBeenCalledWith("account_id", ACCOUNT);
    expect(queriedProducts).toHaveBeenCalledWith("active", true);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  it("skips catalog queries for too-short or too-long input", async () => {
    settingsRead.mockResolvedValue({ data: { confirm_enabled: true, multiproduct_enabled: true }, error: null });
    expect(await (await query("a")).json()).toEqual({ products: [] });
    expect(await (await query("a".repeat(121))).json()).toEqual({ products: [] });
    expect(queriedProducts).not.toHaveBeenCalled();
  });
});
