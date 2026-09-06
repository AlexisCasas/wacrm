import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// feat/automation-durable-followup-media — proves the cron's existing
// pending -> running claim (`UPDATE ... WHERE status = 'pending'`) is what
// makes the durable `wait` queue idempotent: even when two overlapping
// invocations fetch the SAME due row before either claims it, only one of
// them ever calls resumePendingExecution. Nothing here changes that locking;
// this is the "current locking is preserved" test the durable-follow-up
// spec (§8) asks for.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    dueRows: [] as Record<string, unknown>[],
    claimedIds: new Set<string>(),
    fromCalls: [] as string[],
  },
}));

vi.mock("@/lib/automations/admin-client", () => {
  const { state } = h;

  function builder(table: string) {
    state.fromCalls.push(table);
    const ops = {
      table,
      type: "select" as "select" | "update",
      filters: [] as [string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => ((ops.type = "update"), b),
      eq: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        // The claim: UPDATE ... WHERE id = ? AND status = 'pending'.
        if (table === "automation_pending_executions" && ops.type === "update") {
          const id = ops.filters.find((f) => f[0] === "id")?.[1] as string;
          if (state.claimedIds.has(id)) {
            return Promise.resolve({ data: null, error: null });
          }
          state.claimedIds.add(id);
          return Promise.resolve({ data: { id }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        // The initial due-rows fetch — both overlapping invocations see the
        // SAME pre-claim snapshot, exactly like two real cron hits racing
        // against the same due set before either has updated a row.
        if (table === "automation_pending_executions" && ops.type === "select") {
          return Promise.resolve({ data: state.dueRows, error: null }).then(onF, onR);
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
}));

import { GET } from "./route";

const SECRET = "test-cron-secret";

function req() {
  return new Request("http://localhost/api/automations/cron", {
    headers: { "x-cron-secret": SECRET },
  });
}

function pendingRow(id: string) {
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
  };
}

beforeEach(() => {
  h.state.dueRows = [];
  h.state.claimedIds = new Set();
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
    h.state.dueRows = [pendingRow("p1")];

    const res = await GET(req());
    const json = (await res.json()) as { processed: number };

    expect(json.processed).toBe(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", automation_id: "a1", account_id: "acct-1" }),
    );
  });
});

describe("GET /api/automations/cron — idempotent claim under overlap (spec §11.D)", () => {
  it("two invocations racing the SAME pre-claim due snapshot only resume the row once", async () => {
    h.state.dueRows = [pendingRow("p1")];

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
    h.state.dueRows = [pendingRow("p1")];
    await GET(req());
    expect(h.state.fromCalls).not.toContain("flow_runs");
    expect(h.state.fromCalls).not.toContain("ai_autoreply_disabled");
    expect(h.state.fromCalls.every((t) => t === "automation_pending_executions")).toBe(true);
  });
});
