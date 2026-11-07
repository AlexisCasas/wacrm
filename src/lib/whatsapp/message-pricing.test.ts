import { describe, expect, it, vi } from "vitest";
import { captureMessagePricing } from "./message-pricing";

const rpcOk = (data: unknown = true) => ({ rpc: vi.fn(async () => ({ data, error: null })) });
const FEP = { id: "wamid.X", pricing: { type: "free_entry_point", category: "service" }, conversation: { expiration_timestamp: "1794000000", origin: { type: "referral_conversion" } } };

describe("captureMessagePricing", () => {
  it("sends Meta's evidence for the given account", async () => {
    const db = rpcOk();
    expect(await captureMessagePricing(db as never, "acc-1", FEP)).toBe("stored");
    expect(db.rpc).toHaveBeenCalledWith("record_whatsapp_message_pricing", { p_account_id: "acc-1", p_wamid: "wamid.X", p_type: "free_entry_point", p_category: "service", p_expiration: "2026-11-06T21:20:00.000Z" });
  });
  it("calls nothing for a status without FEP evidence", async () => {
    const db = rpcOk();
    for (const st of [{ id: "w" }, { id: "w", pricing: { type: "regular", category: "marketing" } }, { id: "w", pricing: { type: "free_customer_service" } }]) {
      expect(await captureMessagePricing(db as never, "acc-1", st)).toBe("ignored");
    }
    expect(await captureMessagePricing(db as never, "acc-1", { pricing: { type: "free_entry_point" } })).toBe("ignored");
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("a message the account does not own is reported, not an error", async () => {
    expect(await captureMessagePricing(rpcOk(false) as never, "acc-1", FEP)).toBe("unknown_message");
  });
  it("never throws: a database error or exception is 'error' and logs no payload", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await captureMessagePricing({ rpc: async () => ({ data: null, error: { code: "42501", message: "secret row" } }) } as never, "a", FEP)).toBe("error");
    expect(await captureMessagePricing({ rpc: async () => { throw new Error("boom secret"); } } as never, "a", FEP)).toBe("error");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|wamid/);
    spy.mockRestore();
  });
});
