import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// feat/automation-durable-followup-media — proves the cron's existing
// pending -> running claim (`UPDATE ... WHERE status = 'pending'`) is what
// makes the durable `wait` queue idempotent: even when two overlapping
// invocations fetch the SAME due row before either claims it, only one of
// them ever calls resumePendingExecution. Nothing here changes that locking;
// this is the "current locking is preserved" test the durable-follow-up
// spec (§8) asks for.
//
// Meta 131056 retry design, PHASE 3.1 — the mock below models rows as a
// real Map (status, claim_token, lease_expires_at included) with genuine
// SELECT/UPDATE filtering, rather than the earlier simplified
// dueRows/claimedIds pair — needed to characterize and then fix the
// "orphaned running row after a crash" gap (see
// docs/META_131056_AUTOMATION_RETRY_AUDIT.md section "Fase 3.1").
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    rows: new Map<string, Record<string, unknown>>(),
    fromCalls: [] as string[],
  },
}));

vi.mock("@/lib/automations/admin-client", () => {
  const { state } = h;

  function rowMatchesOr(row: Record<string, unknown>, orExpr: string | undefined, nowIso: string): boolean {
    if (!orExpr) return true;
    // Only the exact shape this codebase's cron ever builds:
    //   status.eq.pending,and(status.eq.running,lease_expires_at.lt.<iso>)
    const pendingBranch = row.status === "pending";
    const staleRunningBranch =
      row.status === "running" &&
      typeof row.lease_expires_at === "string" &&
      row.lease_expires_at < nowIso;
    void orExpr; // the mock only ever needs to know THIS predicate, not parse PostgREST syntax generically
    return pendingBranch || staleRunningBranch;
  }

  function builder(table: string) {
    state.fromCalls.push(table);
    const ops = {
      table,
      type: "select" as "select" | "update",
      filters: [] as [string, unknown][],
      orExpr: undefined as string | undefined,
      payload: undefined as Record<string, unknown> | undefined,
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => ((ops.type = "update"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
      lte: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
      or: (expr: string) => ((ops.orExpr = expr), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (table === "automation_pending_executions" && ops.type === "update") {
          const id = ops.filters.find((f) => f[0] === "id")?.[1] as string;
          const statusEq = ops.filters.find((f) => f[0] === "status")?.[1] as string | undefined;
          const claimTokenEq = ops.filters.find((f) => f[0] === "claim_token")?.[1] as string | undefined;
          const row = state.rows.get(id);
          if (!row) return Promise.resolve({ data: null, error: null });
          if (statusEq !== undefined && row.status !== statusEq) {
            return Promise.resolve({ data: null, error: null });
          }
          if (claimTokenEq !== undefined && row.claim_token !== claimTokenEq) {
            return Promise.resolve({ data: null, error: null });
          }
          if (ops.orExpr && !rowMatchesOr(row, ops.orExpr, new Date().toISOString())) {
            return Promise.resolve({ data: null, error: null });
          }
          Object.assign(row, ops.payload);
          return Promise.resolve({ data: { id }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        if (table === "automation_pending_executions" && ops.type === "select") {
          const nowIso = new Date().toISOString();
          const rows = [...state.rows.values()].filter((r) => rowMatchesOr(r, ops.orExpr, nowIso));
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) };
});

const resumeSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/automations/engine", () => ({
  resumePendingExecution: resumeSpy,
  // Phase 3.1 — real value doesn't matter for these tests (the mock
  // filters on lease_expires_at itself), just that it's a positive
  // number so `new Date(Date.now() + N)` produces a future timestamp.
  AUTOMATION_PENDING_LEASE_MS: 15 * 60 * 1000,
}));

import { GET } from "./route";

const SECRET = "test-cron-secret";

function req() {
  return new Request("http://localhost/api/automations/cron", {
    headers: { "x-cron-secret": SECRET },
  });
}

function pendingRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    automation_id: "a1",
    account_id: "acct-1",
    user_id: "u1",
    contact_id: "c1",
    log_id: "log-1",
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: {},
    status: "pending",
    claim_token: null,
    lease_expires_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.rows = new Map();
  h.state.fromCalls = [];
  resumeSpy.mockClear();
  process.env.AUTOMATION_CRON_SECRET = SECRET;
});

describe("GET /api/automations/cron — auth", () => {
  it("rejects a request with no or wrong secret", async () => {
    const res = await GET(new Request("http://localhost/api/automations/cron"));
    expect(res.status).toBe(401);
    expect(resumeSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/automations/cron — processes a due row (spec §11.C)", () => {
  it("claims and resumes exactly one due row", async () => {
    h.state.rows.set("p1", pendingRow("p1"));

    const res = await GET(req());
    const json = (await res.json()) as { processed: number };

    expect(json.processed).toBe(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", automation_id: "a1", account_id: "acct-1" }),
    );
  });
});

describe("GET /api/automations/cron — a defective row never blocks the rest of the batch (final review hardening)", () => {
  it("resumePendingExecution throwing for one row does not stop the remaining rows from being claimed and resumed", async () => {
    h.state.rows.set("p-bad", pendingRow("p-bad"));
    h.state.rows.set("p-good", pendingRow("p-good"));
    resumeSpy.mockImplementationOnce(async () => {
      throw new Error("boom: unexpected throw mid-resume");
    });

    const res = await GET(req());
    const json = (await res.json()) as { processed: number };

    // Both rows were claimed and attempted; only the non-throwing one
    // counts toward `processed`, but the throw never aborts the loop —
    // the second row still gets its own resumePendingExecution call.
    expect(resumeSpy).toHaveBeenCalledTimes(2);
    expect(json.processed).toBe(1);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/automations/cron — idempotent claim under overlap (spec §11.D)", () => {
  it("two invocations racing the SAME pre-claim due snapshot only resume the row once", async () => {
    h.state.rows.set("p1", pendingRow("p1"));

    const [res1, res2] = await Promise.all([GET(req()), GET(req())]);
    const [json1, json2] = await Promise.all([res1.json(), res2.json()]);

    // Exactly one of the two invocations actually processed it...
    expect([json1.processed, json2.processed].sort()).toEqual([0, 1]);
    // ...and resumePendingExecution — the thing that would actually re-run
    // the automation's steps — was invoked exactly once, never twice.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/automations/cron — depends only on the queue itself", () => {
  it("never queries flow_runs or ai_autoreply_disabled while draining the queue", async () => {
    h.state.rows.set("p1", pendingRow("p1"));
    await GET(req());
    expect(h.state.fromCalls).not.toContain("flow_runs");
    expect(h.state.fromCalls).not.toContain("ai_autoreply_disabled");
    expect(h.state.fromCalls.every((t) => t === "automation_pending_executions")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Meta 131056 retry design, PHASE 3.1 — orphaned "running" rows after a
// crash between claim and markPending. See docs/META_131056_AUTOMATION_
// RETRY_AUDIT.md section "Fase 3.1" for the full gap writeup and the fix.
// ---------------------------------------------------------------------------
describe("GET /api/automations/cron — crash recovery (Phase 3.1)", () => {
  it("CR-09: a row stuck in 'running' with an EXPIRED lease is recovered by the next cron tick and resumed again", async () => {
    // Simulates: cron claimed p1 (status->running, a token + lease were
    // set), then the process died before ever calling markPending. The
    // lease is already in the past.
    h.state.rows.set(
      "p1",
      pendingRow("p1", {
        status: "running",
        claim_token: "11111111-1111-1111-1111-111111111111",
        lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const res = await GET(req());
    const json = (await res.json()) as { processed: number };

    expect(json.processed).toBe(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    const row = h.state.rows.get("p1")!;
    // Reclaimed with a NEW token — never the stale one from the dead worker.
    expect(row.claim_token).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(row.status).toBe("running");
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", claim_token: row.claim_token }),
    );
  });

  it("a row stuck in 'running' with a lease that has NOT yet expired is left alone (still owned by whoever holds it)", async () => {
    h.state.rows.set(
      "p1",
      pendingRow("p1", {
        status: "running",
        claim_token: "22222222-2222-2222-2222-222222222222",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const res = await GET(req());
    const json = (await res.json()) as { processed: number };

    expect(json.processed).toBe(0);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(h.state.rows.get("p1")!.claim_token).toBe("22222222-2222-2222-2222-222222222222");
  });
});
