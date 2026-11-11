import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { assertContactCanReceive, ContactBlockedError, AutomatedSendStoppedError } from "./blocking";

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

describe("assertContactCanReceive — Confirmar pedido fence (automatic sends only)", () => {
  const notBlocked = { data: { blocked: false }, error: null };
  const withRpc = (rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>) => ({ ...fakeDb(notBlocked), rpc });

  it("an execution that started before the order is refused right before the send (Flow run)", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const err = await assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1", { flowRunId: "run-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(AutomatedSendStoppedError);
    expect(err).toBeInstanceOf(ContactBlockedError); // every existing "cannot receive" handler stops without sending
    expect(err.code).toBe("order_confirmed");
    expect(rpc).toHaveBeenCalledWith("flow_run_stopped_by_order", { p_account: "acct-1", p_contact: "ct-1", p_run: "run-1" });
  });

  it("same for an Automation execution (its log id)", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await expect(assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1", { automationLogId: "log-1" })).rejects.toBeInstanceOf(AutomatedSendStoppedError);
    expect(rpc).toHaveBeenCalledWith("automation_run_stopped_by_order", { p_account: "acct-1", p_contact: "ct-1", p_log: "log-1" });
  });

  it("an execution that started AFTER the order (contact resumed) is allowed: the fence is not a permanent pause", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    await expect(assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1", { flowRunId: "run-new", automationLogId: "log-new" })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("manual / AI-style callers pass no origin: the fence is never consulted, manual messages are not blocked", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await expect(assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1")).resolves.toBeUndefined();
    await expect(assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1", {})).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a blocked contact still reports ContactBlockedError first (not the order stop)", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const db = { ...fakeDb({ data: { blocked: true }, error: null }), rpc };
    const err = await assertContactCanReceive(db, "acct-1", "ct-1", { flowRunId: "run-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ContactBlockedError);
    expect(err).not.toBeInstanceOf(AutomatedSendStoppedError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rollout: a database without the functions yet means not stopped; any other error fails closed", async () => {
    const missing = vi.fn(async () => ({ data: null, error: { code: "42883", message: "function does not exist" } }));
    await expect(assertContactCanReceive(withRpc(missing), "acct-1", "ct-1", { flowRunId: "run-1" })).resolves.toBeUndefined();
    const broken = vi.fn(async () => ({ data: null, error: { code: "XX000", message: "boom" } }));
    await expect(assertContactCanReceive(withRpc(broken), "acct-1", "ct-1", { flowRunId: "run-1" })).rejects.toThrow(/order-stop fence/);
  });

  it("AI auto-reply origin: the AI fence is asked with the activity start time and refuses the reply", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await expect(assertContactCanReceive(withRpc(rpc), "acct-1", "ct-1", { aiActivityStartedAt: "2026-11-11T10:00:00.000Z" })).rejects.toBeInstanceOf(AutomatedSendStoppedError);
    expect(rpc).toHaveBeenCalledWith("ai_reply_stopped_by_order", { p_account: "acct-1", p_contact: "ct-1", p_since: "2026-11-11T10:00:00.000Z" });
  });
});
