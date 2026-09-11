import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string; blocked?: boolean } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
    pendingInserts: [] as Record<string, unknown>[],
    pendingStatusUpdates: [] as { id: unknown; status: unknown }[],
    contactTagDeletes: [] as { contactId: unknown; tagId: unknown }[],
    conversationLookup: null as { id: string } | null,
    /** Non-update SELECTs against `contacts` so far this test — lets a
     *  test simulate "the contact got blocked mid-run" by flipping
     *  `blocked` starting at a specific call number rather than for
     *  the whole test (see the P0 mid-run blocking race tests). */
    contactsSelectCount: 0,
    /** 1-indexed call number at which `contacts.blocked` starts
     *  reading true (inclusive); null = never. */
    blockContactFromCall: null as number | null,
    /** 1-indexed call number at which the `contacts` blocked-check
     *  SELECT starts erroring (inclusive); null = never. Used to
     *  prove the mid-run check fails CLOSED. */
    contactsSelectErrorFromCall: null as number | null,
    /** What a fresh SELECT against `automation_pending_executions` by
     *  id returns — the P0 cancellation-token re-check. Defaults (set
     *  in beforeEach) to a valid, still-running row matching the
     *  `pending` argument every resumePendingExecution test already
     *  uses, so only the tests that specifically simulate a
     *  cancellation need to override it. */
    freshPendingRow: null as Record<string, unknown> | null,
    freshPendingRowError: null as { message: string } | null,
    /** Non-insert/update reads of `automation_pending_executions` so
     *  far this test — lets a test simulate "block_contact_internal
     *  cancelled this pending row WHILE it was already resuming" by
     *  flipping the freshly-read status to 'done' starting at a
     *  specific call number, mirroring contactsSelectCount/
     *  blockContactFromCall above. */
    pendingSelectCount: 0,
    pendingDoneFromCall: null as number | null,
    /** Meta 131056 durable retry, Phase 3.1 — mirrors pendingDoneFromCall
     *  but simulates a DIFFERENT worker reclaiming this pending row's
     *  lease (a fresh claim_token) starting at a specific 1-indexed
     *  SELECT call number, instead of block_contact_internal cancelling
     *  it. Lets a test prove a stale worker's OWN in-flight resume
     *  notices the mismatch (isPendingExecutionStillRunning -> cancelled)
     *  and that its FINAL markPending call is a no-op once reclaimed. */
    reclaimClaimTokenFromCall: null as number | null,
    reclaimedClaimToken: "tok-reclaimed",
    /** P0 wait-scheduling TOCTOU close — controls what the mocked
     *  schedule_automation_wait_if_contact_active RPC returns.
     *  scheduleWaitError set -> RPC technical failure (fail-closed
     *  test); scheduleWaitBlocked true -> RPC returns false (contact
     *  not eligible), no row inserted; otherwise the mock inserts into
     *  pendingInserts (same shape the old direct insert produced) and
     *  returns true, so every pre-existing assertion against
     *  pendingInserts keeps working unchanged. */
    scheduleWaitError: null as { message: string } | null,
    scheduleWaitBlocked: false,
    scheduleWaitCalls: [] as Record<string, unknown>[],
    /** Meta 131056 durable retry (Phase 3) — same knobs as the wait
     *  scheduler above, for schedule_automation_retry_if_contact_active. */
    scheduleRetryError: null as { message: string } | null,
    scheduleRetryBlocked: false,
    scheduleRetryCalls: [] as Record<string, unknown>[],
    /** Meta 131056 durable retry, Phase 3.1 — markPending's UPDATE now
     *  carries a `status='running' AND claim_token=expected` WHERE
     *  clause. Successful (ownership-matched) updates still land in
     *  `pendingStatusUpdates` exactly as before; a rejected one (stale
     *  worker, mismatched token, or already-moved-on row) lands here
     *  instead, so a test can assert "this call tried to mark done but
     *  had no effect" without needing a full mutable row-state machine. */
    pendingStatusUpdateRejected: [] as { id: unknown; status: unknown }[],
    /** Full update payload (status + claim_token + lease_expires_at) for
     *  every SUCCESSFUL (ownership-matched) automation_pending_executions
     *  update — lets a test confirm markPending clears claim metadata on
     *  completion, without disturbing pendingStatusUpdates' existing
     *  exact-shape {id, status} assertions used throughout this file. */
    pendingStatusUpdatePayloads: [] as Record<string, unknown>[],
    /** Meta pacing, Phase 4 — one-shot: when set, the NEXT
     *  `contacts.update` call (i.e. an `update_contact_field` step
     *  running between two Meta sends) advances vitest's fake clock by
     *  this many ms before resolving, simulating "normal processing
     *  time" elapsing between the two sends — see PC-03's own comment
     *  for why this specific hook point (not a generic sleep) is what
     *  lets a test prove pacing waits only the REMAINING interval, not
     *  the full one, without really sleeping. Cleared after firing
     *  once; only meaningful under vi.useFakeTimers(). */
    advanceClockOnContactUpdateMs: null as number | null,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        if (state.advanceClockOnContactUpdateMs != null) {
          // vi.setSystemTime (NOT vi.advanceTimersByTimeAsync) — this
          // only needs Date.now() to read later, never to fire any
          // pending setTimeout in between, and doing it synchronously
          // avoids nesting a second async timer-advance inside the one
          // the test itself is already driving.
          const ms = state.advanceClockOnContactUpdateMs;
          state.advanceClockOnContactUpdateMs = null;
          vi.setSystemTime(new Date(Date.now() + ms));
        }
        return { data: null, error: null };
      }
      // ownership guard / condition read / P0 mid-run blocked recheck
      state.contactsSelectCount += 1;
      if (
        state.contactsSelectErrorFromCall !== null &&
        state.contactsSelectCount >= state.contactsSelectErrorFromCall
      ) {
        return { data: null, error: { message: "connection reset" } };
      }
      if (
        state.owned &&
        state.blockContactFromCall !== null &&
        state.contactsSelectCount >= state.blockContactFromCall
      ) {
        return { data: { ...state.owned, blocked: true }, error: null };
      }
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "automations") {
      // resumePendingExecution looks up ONE automation by id (`.eq('id', ...).single()`);
      // runAutomationsForTrigger's dispatch fetch filters by account/trigger/is_active
      // instead and expects the whole matching array. Distinguish by the presence
      // of an `id` filter so both call sites share this one resolver.
      const idFilter = ops.filters.find((f) => f[0] === "eq" && f[1] === "id");
      if (idFilter) {
        const found = state.automations.find((a) => a.id === idFilter[2]) ?? null;
        return { data: found, error: null };
      }
      return { data: state.automations, error: null };
    }
    if (table === "automation_pending_executions") {
      // Meta 131056 retry metadata (Phase 3) — default a fixture that
      // doesn't mention these fields to "plain wait" shape (retry_count
      // 0, retry_reason/retry_step_id null), exactly like a real row
      // would look post-migration-050 for every pending this repo's
      // existing tests ever set up. Tests that specifically exercise
      // retry behavior set these fields explicitly and take precedence
      // (the `??` below only fills in what's actually absent).
      // Phase 3.1 adds the same treatment for claim_token: a fixture
      // that doesn't mention it defaults to "tok-default", matching
      // every pre-existing resumePendingExecution/resumePending call in
      // this file (which now all pass claim_token: "tok-default" too).
      const withRetryDefaults = (
        row: Record<string, unknown> | null,
      ): Record<string, unknown> | null =>
        row === null
          ? null
          : {
              ...row,
              retry_count: row.retry_count ?? 0,
              retry_reason: row.retry_reason ?? null,
              retry_step_id: row.retry_step_id ?? null,
              claim_token: row.claim_token ?? "tok-default",
            };
      // Meta 131056 durable retry, Phase 3.1 — the CURRENT state of the
      // row, as of THIS call, accounting for any drift a test scheduled
      // via pendingDoneFromCall (block_contact_internal cancelling it)
      // or reclaimClaimTokenFromCall (a different worker reclaiming its
      // lease mid-resume). Both SELECT and UPDATE below read through
      // this single function so a drift scheduled to happen "starting at
      // call N" is honored identically by a fresh re-read AND by
      // markPending's ownership-aware UPDATE, exactly like a real
      // Postgres row would look to both statements.
      const effectiveFreshPendingRow = (): Record<string, unknown> | null => {
        if (!state.freshPendingRow) return null;
        let row = withRetryDefaults(state.freshPendingRow)!;
        if (state.pendingDoneFromCall !== null && state.pendingSelectCount >= state.pendingDoneFromCall) {
          row = { ...row, status: "done" };
        }
        if (
          state.reclaimClaimTokenFromCall !== null &&
          state.pendingSelectCount >= state.reclaimClaimTokenFromCall
        ) {
          row = { ...row, claim_token: state.reclaimedClaimToken };
        }
        return row;
      };
      if (type === "insert") {
        state.pendingInserts.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (type === "update") {
        const id = ops.filters.find((f) => f[1] === "id")?.[2];
        const payload = ops.payload as { status?: unknown } | undefined;
        const status = payload?.status;
        // Meta 131056 durable retry, Phase 3.1 — markPending is now
        // ownership-aware: `.eq('status','running').eq('claim_token', X)`.
        // Model that here against the SAME canonical (possibly drifted)
        // row every fresh SELECT in this test would return right now —
        // if either filter doesn't match the row's CURRENT claim, this
        // update is a no-op, exactly like the real conditional UPDATE
        // affecting 0 rows.
        const statusFilter = ops.filters.find((f) => f[0] === "eq" && f[1] === "status")?.[2];
        const claimTokenFilter = ops.filters.find((f) => f[0] === "eq" && f[1] === "claim_token")?.[2];
        const current = effectiveFreshPendingRow();
        const ownershipOk =
          (statusFilter === undefined || current?.status === statusFilter) &&
          (claimTokenFilter === undefined || current?.claim_token === claimTokenFilter);
        if (ownershipOk) {
          state.pendingStatusUpdates.push({ id, status });
          state.pendingStatusUpdatePayloads.push({ id, ...(payload ?? {}) });
        } else {
          state.pendingStatusUpdateRejected.push({ id, status });
        }
        return { data: null, error: null };
      }
      // The P0 cancellation-token re-checks (resumePendingExecution's
      // own revalidation, and executeStepsFrom's per-step
      // isPendingExecutionStillRunning) both do a plain SELECT by id.
      state.pendingSelectCount += 1;
      return { data: effectiveFreshPendingRow(), error: state.freshPendingRowError };
    }
    if (table === "contact_tags") {
      if (type === "delete") {
        const contactId = ops.filters.find((f) => f[1] === "contact_id")?.[2];
        const tagId = ops.filters.find((f) => f[1] === "tag_id")?.[2];
        state.contactTagDeletes.push({ contactId, tagId });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "conversations") {
      return { data: state.conversationLookup, error: null };
    }
    if (table === "automation_logs") {
      if (type === "insert") {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: "log1" }, error: null };
      }
      if (type === "update") {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") {
      const idEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "id");
      if (idEq) {
        // Two single-row-by-id shapes share this branch, structurally
        // distinct from the scoped array fetch below:
        //   - resumeAndUnwind's ancestor lookup: .eq('id', X).eq('automation_id', Y)
        //   - isRetryTargetStillValid's exact-step check (Phase 3):
        //     .eq('id', X).eq('automation_id', Y).eq('position', P)
        //     .is/.eq('parent_step_id', ...).is/.eq('branch', ...)
        // Every filter actually present on the query is enforced;
        // filters neither shape sends are simply absent from `ops.filters`
        // and skipped, so this one resolver correctly serves both.
        const automationIdEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "automation_id");
        const positionEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "position");
        const parentStepIdIsNull = ops.filters.find((f) => f[0] === "is" && f[1] === "parent_step_id");
        const parentStepIdEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "parent_step_id");
        const branchIsNull = ops.filters.find((f) => f[0] === "is" && f[1] === "branch");
        const branchEqForId = ops.filters.find((f) => f[0] === "eq" && f[1] === "branch");
        const found = state.steps.find((s) => {
          const step = s as Record<string, unknown>;
          if (step.id !== idEq[2]) return false;
          if (automationIdEq && step.automation_id !== automationIdEq[2]) return false;
          if (positionEq && step.position !== positionEq[2]) return false;
          if (parentStepIdIsNull && step.parent_step_id !== null) return false;
          if (parentStepIdEq && step.parent_step_id !== parentStepIdEq[2]) return false;
          if (branchIsNull && step.branch !== null) return false;
          if (branchEqForId && step.branch !== branchEqForId[2]) return false;
          return true;
        });
        return { data: found ?? null, error: null };
      }
      // Real executeStepsFrom query shape:
      //   .eq('automation_id', ...).gte('position', start).order(...)
      //   + either .is('parent_step_id', null)
      //         or .eq('parent_step_id', parentId).eq('branch', branch)
      // Earlier engine.test.ts revisions returned `state.steps`
      // unfiltered here — harmless for every existing test (they only
      // ever exercise ONE scope per run), but it would silently paper
      // over a nested condition/branch scope bleeding steps into its
      // parent or vice versa. Filtering for real is what makes the
      // nested condition+wait pause-propagation test below meaningful.
      const isNullFilter = ops.filters.find((f) => f[0] === "is" && f[1] === "parent_step_id");
      const parentEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "parent_step_id");
      const branchEq = ops.filters.find((f) => f[0] === "eq" && f[1] === "branch");
      const positionGte = ops.filters.find((f) => f[0] === "gte" && f[1] === "position");
      const filtered = state.steps.filter((s) => {
        const step = s as Record<string, unknown>;
        if (isNullFilter && step.parent_step_id !== null) return false;
        if (parentEq && step.parent_step_id !== parentEq[2]) return false;
        if (branchEq && step.branch !== branchEq[2]) return false;
        if (positionGte && !((step.position as number) >= (positionGte[2] as number))) return false;
        return true;
      });
      filtered.sort((a, b) => (a as { position: number }).position - (b as { position: number }).position);
      return { data: filtered, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(["gte", k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(["is", k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "schedule_automation_wait_if_contact_active") {
          state.scheduleWaitCalls.push(args);
          if (state.scheduleWaitError) {
            return Promise.resolve({ data: null, error: state.scheduleWaitError });
          }
          if (state.scheduleWaitBlocked) {
            return Promise.resolve({ data: false, error: null });
          }
          // Simulate the real RPC's own INSERT so every pre-existing
          // assertion against pendingInserts keeps working unchanged.
          state.pendingInserts.push({
            automation_id: args.p_automation_id,
            account_id: args.p_account_id,
            user_id: args.p_user_id,
            contact_id: args.p_contact_id,
            log_id: args.p_log_id,
            parent_step_id: args.p_parent_step_id,
            branch: args.p_branch,
            next_step_position: args.p_next_step_position,
            context: args.p_context,
            run_at: args.p_run_at,
            status: "pending",
            retry_count: 0,
            retry_reason: null,
            retry_step_id: null,
          });
          return Promise.resolve({ data: true, error: null });
        }
        // Meta 131056 durable retry (Phase 3) — mirrors the wait RPC
        // mock above, with its own independent error/blocked knobs so a
        // test can simulate a retry-scheduling failure without also
        // affecting (nonexistent, in these tests) plain waits in the
        // same run, and vice versa.
        if (name === "schedule_automation_retry_if_contact_active") {
          state.scheduleRetryCalls.push(args);
          if (state.scheduleRetryError) {
            return Promise.resolve({ data: null, error: state.scheduleRetryError });
          }
          if (state.scheduleRetryBlocked) {
            return Promise.resolve({ data: false, error: null });
          }
          state.pendingInserts.push({
            automation_id: args.p_automation_id,
            account_id: args.p_account_id,
            user_id: args.p_user_id,
            contact_id: args.p_contact_id,
            log_id: args.p_log_id,
            parent_step_id: args.p_parent_step_id,
            branch: args.p_branch,
            next_step_position: args.p_next_step_position,
            context: args.p_context,
            run_at: args.p_run_at,
            status: "pending",
            retry_count: args.p_retry_count,
            retry_reason: args.p_retry_reason,
            retry_step_id: args.p_retry_step_id,
          });
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import {
  runAutomationsForTrigger,
  triggerMatches,
  resumePendingExecution,
  AUTOMATION_META_OUTBOUND_PACING_MS,
} from "./engine";
import {
  engineSendMedia as mockEngineSendMedia,
  engineSendText as mockEngineSendText,
  engineSendTemplate as mockEngineSendTemplate,
  engineSendInteractive as mockEngineSendInteractive,
} from "./meta-send";
import { MetaApiError } from "@/lib/whatsapp/meta-api";
import type { Automation, KeywordMatchTriggerConfig } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.pendingInserts = [];
  h.state.pendingStatusUpdates = [];
  h.state.contactTagDeletes = [];
  h.state.conversationLookup = null;
  h.state.contactsSelectCount = 0;
  h.state.blockContactFromCall = null;
  h.state.contactsSelectErrorFromCall = null;
  // Default: a valid, still-running pending row matching what every
  // existing resumePendingExecution test already passes as `pending`.
  // Tests that specifically simulate a cancellation override this.
  h.state.freshPendingRow = {
    id: "pending-1",
    status: "running",
    automation_id: "a1",
    account_id: ACCOUNT,
    contact_id: "c1",
  };
  h.state.freshPendingRowError = null;
  h.state.pendingSelectCount = 0;
  h.state.pendingDoneFromCall = null;
  h.state.scheduleWaitError = null;
  h.state.scheduleWaitBlocked = false;
  h.state.scheduleWaitCalls = [];
  h.state.scheduleRetryError = null;
  h.state.scheduleRetryBlocked = false;
  h.state.scheduleRetryCalls = [];
  h.state.pendingStatusUpdateRejected = [];
  h.state.pendingStatusUpdatePayloads = [];
  h.state.reclaimClaimTokenFromCall = null;
  h.state.reclaimedClaimToken = "tok-reclaimed";
  h.state.advanceClockOnContactUpdateMs = null;
  // .mockReset() (not just .mockClear()) — .mockClear() only wipes call
  // history, it does NOT drain any mockRejectedValueOnce/
  // mockImplementationOnce queue a Meta-131056 test left un-consumed
  // (e.g. a test that expected N sends but only reached N-1 due to an
  // earlier exception). A leftover queued rejection would otherwise
  // silently fire on the NEXT test's first send call instead of this
  // one's, producing a confusing failure in a test that never touched
  // it. .mockReset() clears that queue too, so the default
  // implementation has to be reassigned right after.
  vi.mocked(mockEngineSendMedia).mockReset().mockImplementation(async () => ({ whatsapp_message_id: "m1" }));
  vi.mocked(mockEngineSendText).mockReset().mockImplementation(async () => ({ whatsapp_message_id: "m1" }));
  vi.mocked(mockEngineSendTemplate).mockReset().mockImplementation(async () => ({ whatsapp_message_id: "m1" }));
  vi.mocked(mockEngineSendInteractive).mockReset().mockImplementation(async () => ({ whatsapp_message_id: "m1" }));
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("P0 contact blocking — refuses to dispatch when the contact is blocked", async () => {
    h.state.owned = { id: "c1", blocked: true };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // Bailed right after the ownership check, before ever loading automations.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("automation_logs — status is seeded pessimistically (issue #409)", () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: "failed",
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => "status" in u);
    expect(withStatus.at(-1)).toMatchObject({ status: "success" });
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain("automation_steps");
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_webhook",
    position: 0,
    parent_step_id: null,
    step_config: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});

describe("triggerMatches — tag_added", () => {
  function automation(tagId?: string): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag follow-up",
      trigger_type: "tag_added",
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches only the exact tag id", () => {
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-a" })).toBe(true);
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-ab" })).toBe(false);
  });

  it("fails closed when the config or event tag is missing", () => {
    expect(triggerMatches(automation(), { tag_id: "tag-a" })).toBe(false);
    expect(triggerMatches(automation("tag-a"), {})).toBe(false);
    expect(triggerMatches(automation("tag-a"), undefined)).toBe(false);
  });
});

describe("tag_added — conversation policy", () => {
  it("records a clear failed step when the contact has no conversation", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [{
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag outreach",
      trigger_type: "tag_added",
      trigger_config: { tag_id: "tag-a" },
      is_active: true,
    }];
    h.state.steps = [{
      id: "s1",
      automation_id: "a1",
      step_type: "send_message",
      position: 0,
      parent_step_id: null,
      step_config: { text: "Hello" },
    }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-a" },
    });

    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({
      status: "failed",
      error_message: "tag_added automation cannot send: contact has no existing conversation",
    }));
  });
});

describe("triggerMatches — keyword_match", () => {
  function automation(
    cfg: Partial<KeywordMatchTriggerConfig> & { keywords: string[] },
  ): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "kw",
      trigger_type: "keyword_match",
      trigger_config: { match_type: "contains", ...cfg },
      is_active: true,
    } as unknown as Automation;
  }

  const on = (a: Automation, text: string) =>
    triggerMatches(a, { message_text: text });

  it("keeps `contains` as a raw substring test", () => {
    // Issue #409 asked for this to become word-boundary matching. It
    // deliberately did NOT change: existing automations relying on
    // substring behaviour ("cat" firing on "category") must keep working,
    // and `contains` is the builder's default. `word` is the opt-in fix.
    expect(on(automation({ keywords: ["k"] }), "thanks")).toBe(true);
    expect(on(automation({ keywords: ["cat"] }), "category")).toBe(true);
  });

  it("`word` matches only standalone words", () => {
    const a = automation({ keywords: ["k"], match_type: "word" });
    expect(on(a, "thanks")).toBe(false);
    expect(on(a, "k")).toBe(true);
    expect(on(a, "press k to continue")).toBe(true);
    expect(on(a, "press K!")).toBe(true);
  });

  it("`word` respects punctuation and line edges around the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "word" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi!")).toBe(true);
    expect(on(a, "(hi)")).toBe(true);
    expect(on(a, "say hi.")).toBe(true);
    expect(on(a, "this")).toBe(false);
    expect(on(a, "hiya")).toBe(false);
  });

  it("`word` handles a keyword that itself carries punctuation", () => {
    // `\b` can't do this: /\bhi!\b/ demands a word char after the "!",
    // so it never matches. Hence the lookaround implementation.
    const a = automation({ keywords: ["hi!"], match_type: "word" });
    expect(on(a, "say hi!")).toBe(true);
    expect(on(a, "hi! there")).toBe(true);
  });

  it("`word` treats regex metacharacters in a keyword as literal", () => {
    // Account-supplied free text — an unescaped "(" would throw.
    const a = automation({ keywords: ["c++ (beginner)"], match_type: "word" });
    expect(on(a, "I want the c++ (beginner) course")).toBe(true);
    expect(on(a, "I want the cxx beginner course")).toBe(false);
    expect(() => on(automation({ keywords: ["("], match_type: "word" }), "(")).not.toThrow();
  });

  it("`word` is case-insensitive unless case_sensitive is set", () => {
    expect(on(automation({ keywords: ["Hi"], match_type: "word" }), "hi")).toBe(true);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "hi",
      ),
    ).toBe(false);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "Hi",
      ),
    ).toBe(true);
  });

  it("`word` finds a space-delimited keyword in a non-Latin script", () => {
    // ASCII `\b` fails outright here — every character of "안녕" is a
    // non-word character to it, so /\b안녕\b/ matches nothing.
    const a = automation({ keywords: ["안녕"], match_type: "word" });
    expect(on(a, "안녕")).toBe(true);
    expect(on(a, "저기 안녕 하세요")).toBe(true);
    // Documented limitation, not an accident: a language written without
    // spaces has no word edge inside a run of characters.
    expect(on(a, "안녕하세요")).toBe(false);
  });

  it("`exact` still requires the whole message to be the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "exact" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi there")).toBe(false);
  });

  it("ignores empty keywords and empty messages in `word` mode", () => {
    expect(on(automation({ keywords: [""], match_type: "word" }), "anything")).toBe(false);
    expect(on(automation({ keywords: ["hi"], match_type: "word" }), "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// feat/automation-durable-followup-media — durable `wait`, the remove_tag-
// before-wait follow-up pattern, and the new `send_media` step. These reuse
// the SAME `automation_pending_executions` queue the `wait` step has always
// written to; nothing here introduces a second scheduler.
// ---------------------------------------------------------------------------

function waitStep(position: number, amount: number, unit: "minutes" | "hours" | "days") {
  return {
    id: `wait-${position}`,
    automation_id: "a1",
    step_type: "wait",
    position,
    parent_step_id: null,
    step_config: { amount, unit },
  };
}

function removeTagStep(position: number, tagId: string) {
  return {
    id: `remove-${position}`,
    automation_id: "a1",
    step_type: "remove_tag",
    position,
    parent_step_id: null,
    step_config: { tag_id: tagId },
  };
}

function sendMediaStep(position: number, config: Record<string, unknown>) {
  return {
    id: `media-${position}`,
    automation_id: "a1",
    step_type: "send_media",
    position,
    parent_step_id: null,
    step_config: config,
  };
}

function tagAddedAutomation() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "tag_added",
    trigger_config: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    is_active: true,
  };
}

function conditionStep(position: number, subject: string, value: string) {
  return {
    id: "cond1",
    automation_id: "a1",
    step_type: "condition",
    position,
    parent_step_id: null,
    step_config: { subject, value },
  };
}

function sendMessageStep(position: number, parentStepId: string | null, branch: "yes" | "no" | null) {
  return {
    id: `send-${position}-${branch ?? "root"}`,
    automation_id: "a1",
    step_type: "send_message",
    position,
    parent_step_id: parentStepId,
    branch,
    step_config: { text: "hi" },
  };
}

// ---------------------------------------------------------------------------
// Meta 131056 retry design, PHASE 1 — fix verification. These used to be
// characterization tests documenting two confirmed bugs (see
// docs/META_131056_AUTOMATION_RETRY_AUDIT.md sections F and B/D):
//
//   1. A nested branch pausing/failing did not stop the scope that
//      contains it — the parent kept running its own next steps
//      immediately (during the SAME synchronous dispatch).
//   2. After a branch was resumed by the cron and finished, nothing ever
//      continued the scope(s) that contain it — the root's remaining
//      steps simply never ran, ever, no matter how long you waited.
//
// Both are now fixed via ExecutionOutcome (executeStepsFrom returns
// completed/paused/failed instead of void) and resumeAndUnwind (climbs
// back up the ancestor chain, reconstructed from automation_steps, after
// a resumed branch completes). These tests now assert the CORRECT,
// fixed behavior — a regression here means one of the two bugs is back.
// ---------------------------------------------------------------------------
describe("executeStepsFrom — nested condition branch pause/failure propagation (fix verification)", () => {
  it("FIXED: the root scope does NOT execute its own next step while the YES branch is still suspended on `wait`", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "new_message_received",
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      // root: condition at position 0
      conditionStep(0, "message_content", "hello"),
      // YES branch: send (0) -> wait (1) -> remove_tag (2, must NEVER run)
      sendMessageStep(0, "cond1", "yes"),
      { ...waitStep(1, 10, "minutes"), parent_step_id: "cond1", branch: "yes" },
      { ...removeTagStep(2, "tag-x"), parent_step_id: "cond1", branch: "yes" },
      // root: next sibling step AFTER the condition, position 1
      updateStepAt(1),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    // The YES branch reaches and suspends at `wait`: a pending row was
    // scheduled, and remove_tag (branch position 2, after the wait) never ran.
    expect(h.state.pendingInserts).toHaveLength(1);
    expect(h.state.contactTagDeletes).toHaveLength(0);

    // FIXED: the root's next step must NOT run while the branch is paused —
    // the condition handler now inspects the recursive call's outcome and
    // returns instead of `continue`-ing past it.
    expect(h.state.updateCalls).toHaveLength(0);
    // The overall log correctly reflects "still in progress" (partial), not
    // a false 'success' — root's own finishScope call maps a propagated
    // `paused` outcome to status='partial'.
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "partial" }));
  });

  it("FIXED: a failure inside a nested YES branch stops the root scope, and the log ends 'failed' — never 'success'", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "new_message_received",
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      // YES branch: a step guaranteed to throw (send_template with no
      // template_name).
      {
        id: "fail-branch",
        automation_id: "a1",
        step_type: "send_template",
        position: 0,
        parent_step_id: "cond1",
        branch: "yes",
        step_config: {},
      },
      // root: next sibling step after the condition — must NOT run.
      updateStepAt(1),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    // The nested branch's own failure message survives all the way to root...
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ error_message: "send_template needs template_name" }),
    );
    // ...and root's own finishScope call — the one that actually decides
    // automation_logs.status — correctly writes 'failed', not 'success'.
    const statusWrites = h.state.logUpdates.filter((u) => "status" in u);
    expect(statusWrites[statusWrites.length - 1]).toMatchObject({ status: "failed" });

    // FIXED: the root step after the condition never runs.
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Meta 131056 retry design, PHASE 1 — ancestor continuation after a branch
// resume (fix verification). CP-A through CP-I match
// docs/META_131056_AUTOMATION_RETRY_AUDIT.md section D / this phase's spec.
// ---------------------------------------------------------------------------
describe("resumePendingExecution — ancestor continuation after a branch resume (fix verification)", () => {
  it("CP-A: root condition YES -> wait -> root step. Root step does NOT run before resume; runs exactly ONCE after", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { ...waitStep(0, 10, "minutes"), parent_step_id: "cond1", branch: "yes" },
      updateStepAt(1), // root position 1
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    expect(h.state.pendingInserts).toHaveLength(1);
    // BEFORE resume: root step must not have run (fix from the describe
    // block above — no more premature continuation).
    expect(h.state.updateCalls).toHaveLength(0);

    const pendingA = h.state.pendingInserts[0];
    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-default",
    });

    // AFTER resume: the branch completes (nothing left after the wait),
    // resumeAndUnwind climbs from cond1 back to root, and root's step runs
    // — exactly once.
    expect(h.state.updateCalls).toHaveLength(1);
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-A", status: "done" });
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("CP-B: 2 nested conditions with a deep wait — resume continues after B, then after A, then root, each exactly once", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"), // A, id "cond1", root position 0
      { id: "condB", automation_id: "a1", step_type: "condition", position: 0, parent_step_id: "cond1", branch: "yes", step_config: { subject: "message_content", value: "hello" } },
      { ...waitStep(0, 10, "minutes"), parent_step_id: "condB", branch: "yes" },
      // "step after B" — inside A's YES branch, position 1.
      { ...updateStepAt(1), parent_step_id: "cond1", branch: "yes", step_config: { field: "company", value: "after-B" } },
      // "step after A" — root position 1.
      updateStepAt(1),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    expect(h.state.pendingInserts).toHaveLength(1);
    const pendingA = h.state.pendingInserts[0];
    expect(pendingA.parent_step_id).toBe("condB");
    expect(h.state.updateCalls).toHaveLength(0);

    h.state.freshPendingRow = { id: "pending-deep", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-deep",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: {},
      claim_token: "tok-default",
    });

    // Both "after B" and "after A" ran, each exactly once.
    expect(h.state.updateCalls).toHaveLength(2);
    const fields = h.state.updateCalls.map((c) => c.filters);
    expect(fields).toEqual([
      expect.arrayContaining([["eq", "id", "c1"]]), // "after B" write (contacts.update)
      expect.arrayContaining([["eq", "id", "c1"]]), // "after A" write (contacts.update)
    ]);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("CP-C: a resumed branch failure -> automation_logs.status ends 'failed' (not stuck at 'partial'), ancestors never run, Pending A done", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { ...waitStep(0, 10, "minutes"), parent_step_id: "cond1", branch: "yes" },
      { id: "fail-branch", automation_id: "a1", step_type: "send_template", position: 1, parent_step_id: "cond1", branch: "yes", step_config: {} },
      updateStepAt(1),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "partial" }));

    const pendingA = h.state.pendingInserts[0];
    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };
    h.state.logUpdates = [];
    h.state.updateCalls = [];

    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: {},
      claim_token: "tok-default",
    });

    // FIXED: resumePendingExecution notices the failure happened before
    // reaching root (executeStepsFrom's nested convention suppressed the
    // status write) and finalizes the log itself.
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "send_template needs template_name" }),
    );
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-A", status: "done" });
    // Root/ancestor step never runs on a failed unwind.
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("CP-D: a resumed branch that waits AGAIN -> Pending A done, Pending B pending, ancestors silent; once B completes, ancestors continue exactly once", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      sendMessageStep(0, "cond1", "yes"),
      { ...waitStep(1, 10, "minutes"), parent_step_id: "cond1", branch: "yes" }, // Pending A stops here
      sendMessageStep(2, "cond1", "yes"),
      { ...waitStep(3, 5, "minutes"), parent_step_id: "cond1", branch: "yes" }, // Pending B created on resume of A
      { ...removeTagStep(4, "tag-x"), parent_step_id: "cond1", branch: "yes" },
      updateStepAt(1), // root
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    expect(h.state.pendingInserts).toHaveLength(1);
    const pendingA = h.state.pendingInserts[0];
    expect(pendingA.next_step_position).toBe(2);
    expect(h.state.updateCalls).toHaveLength(0);

    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-default",
    });

    // Pending A consumed; Pending B created independently, still pending;
    // ancestors did NOT run yet (correct — outcome was 'paused', not
    // 'completed', so resumeAndUnwind stops without climbing).
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-A", status: "done" });
    expect(h.state.pendingInserts).toHaveLength(2);
    const pendingB = h.state.pendingInserts[1];
    expect(pendingB.next_step_position).toBe(4);
    expect(pendingB.parent_step_id).toBe("cond1");
    expect(h.state.contactTagDeletes).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "partial" }));

    // Now resume Pending B — its own branch scope completes (remove_tag
    // runs, nothing after it in the branch), so THIS TIME the unwind climbs
    // all the way to root.
    h.state.freshPendingRow = { id: "pending-B", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-B",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingB.log_id as string) ?? "log1",
      parent_step_id: pendingB.parent_step_id as string,
      branch: pendingB.branch as "yes",
      next_step_position: pendingB.next_step_position as number,
      context: {},
      claim_token: "tok-default",
    });

    expect(h.state.contactTagDeletes).toHaveLength(1);
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-B", status: "done" });
    // Ancestors continue NOW, exactly once.
    expect(h.state.updateCalls).toHaveLength(1);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("CP-E: a condition branch that completes without any wait/failure keeps working exactly as before (regression guard)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      sendMessageStep(0, "cond1", "yes"),
      updateStepAt(1),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    expect(h.state.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "contacts",
        filters: expect.arrayContaining([["eq", "id", "c1"]]),
      }),
    );
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("CP-F: the condition's own result is not lost, and not duplicated, when a nested `paused` outcome propagates through it", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { ...waitStep(0, 10, "minutes"), parent_step_id: "cond1", branch: "yes" },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    const allSteps = h.state.logUpdates.flatMap(
      (u) => (u.steps_executed as { step_id: string; status: string; detail?: string }[] | undefined) ?? [],
    );
    const conditionResults = allSteps.filter((r) => r.step_id === "cond1");
    const waitResults = allSteps.filter((r) => r.step_id === "wait-0");
    expect(conditionResults).toHaveLength(1);
    expect(conditionResults[0]).toMatchObject({ status: "success", detail: "branch=yes" });
    expect(waitResults).toHaveLength(1);
  });

  it("CP-G: the condition's own result is not lost, and not duplicated, when a nested `failed` outcome propagates through it", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { id: "fail-branch", automation_id: "a1", step_type: "send_template", position: 0, parent_step_id: "cond1", branch: "yes", step_config: {} },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    const allSteps = h.state.logUpdates.flatMap(
      (u) => (u.steps_executed as { step_id: string; status: string; detail?: string }[] | undefined) ?? [],
    );
    const conditionResults = allSteps.filter((r) => r.step_id === "cond1");
    const failResults = allSteps.filter((r) => r.step_id === "fail-branch");
    expect(conditionResults).toHaveLength(1);
    expect(conditionResults[0]).toMatchObject({ status: "success", detail: "branch=yes" });
    expect(failResults).toHaveLength(1);
    expect(failResults[0]).toMatchObject({ status: "failed", detail: "send_template needs template_name" });
  });

  it("CP-H: ancestor lookup that isn't a real `condition` step (wrong type) fails closed — log failed, no side effects", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      // "corrupt-parent" is NOT a condition — a well-formed system would
      // never point a pending row's parent_step_id at it, but the unwind
      // must not trust that blindly.
      { id: "corrupt-parent", automation_id: "a1", step_type: "send_message", position: 0, parent_step_id: null, branch: null, step_config: { text: "hi" } },
      updateStepAt(1), // must NEVER run
    ];

    h.state.freshPendingRow = { id: "pending-X", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-X",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log1",
      parent_step_id: "corrupt-parent", // resumed branch's own scope has 0 steps left -> completes trivially
      branch: "yes",
      next_step_position: 99,
      context: {},
      claim_token: "tok-default",
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "ancestor_step_lookup_failed" }),
    );
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-X", status: "done" });
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("CP-H2: ancestor lookup scoped to a DIFFERENT automation_id is treated as not found — fails closed the same way", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      // A condition that exists, but belongs to a DIFFERENT automation —
      // the lookup must scope by automation_id, not just by id.
      { id: "foreign-cond", automation_id: "other-automation", step_type: "condition", position: 0, parent_step_id: null, branch: null, step_config: {} },
      updateStepAt(1),
    ];

    h.state.freshPendingRow = { id: "pending-Y", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    await resumePendingExecution({
      id: "pending-Y",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log1",
      parent_step_id: "foreign-cond",
      branch: "yes",
      next_step_position: 99,
      context: {},
      claim_token: "tok-default",
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "ancestor_step_lookup_failed" }),
    );
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("CP-I: block_contact_internal cancelling Pending A's row DURING the ancestor unwind stops the very next step from running", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { ...waitStep(0, 10, "minutes"), parent_step_id: "cond1", branch: "yes" },
      updateStepAt(1), // root — must NOT run: cancellation is detected right here
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    const pendingA = h.state.pendingInserts[0];

    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };
    // Every SELECT-by-id against automation_pending_executions shares one
    // counter: call #1 is resumePendingExecution's OWN initial revalidation
    // (must still see 'running', or nothing below would ever run). The
    // branch itself has 0 steps left after the wait, so it never reaches a
    // per-step pendingExecutionId check — the ancestor lookup (a DIFFERENT
    // table, automation_steps) doesn't count either. The NEXT
    // pending-executions select is call #2: root's own per-step check,
    // once the unwind has climbed there. Flipping to 'done' starting at
    // call #2 simulates block_contact_internal cancelling this pending
    // exactly then — mid-unwind, after the branch already finished.
    h.state.pendingDoneFromCall = 2;

    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-default",
    });

    // The root step, reached only via ancestor unwind, never ran.
    expect(h.state.updateCalls).toHaveLength(0);
    // Meta 131056 durable retry, Phase 3.1 — markPending is now
    // ownership-aware (`WHERE status='running' AND claim_token=X`).
    // block_contact_internal already flipped this row to 'done' by the
    // time resumeAndUnwind finishes, so THIS worker's own final
    // "mark it done" call correctly finds 0 matching rows and is a
    // no-op — the row is already terminally done via the other writer,
    // there is nothing left for this call to (or that it safely could)
    // overwrite.
    expect(h.state.pendingStatusUpdates).toHaveLength(0);
    expect(h.state.pendingStatusUpdateRejected).toContainEqual({ id: "pending-A", status: "done" });
  });
});

function updateStepAt(position: number) {
  return {
    id: `root-update-${position}`,
    automation_id: "a1",
    step_type: "update_contact_field",
    position,
    parent_step_id: null,
    step_config: { field: "company", value: "root-step-ran" },
  };
}

describe("wait — durable follow-up scheduling (spec §11.A)", () => {
  it("enqueues a pending row with run_at ≈ now + the configured duration", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];

    const before = Date.now();
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });
    const after = Date.now();

    expect(h.state.pendingInserts).toHaveLength(1);
    const row = h.state.pendingInserts[0];
    expect(row).toMatchObject({
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
      status: "pending",
      next_step_position: 1,
    });
    const runAt = new Date(row.run_at as string).getTime();
    const tenHoursMs = 10 * 60 * 60 * 1000;
    expect(runAt).toBeGreaterThanOrEqual(before + tenHoursMs);
    expect(runAt).toBeLessThanOrEqual(after + tenHoursMs + 1000);
  });

  it("never touches flow_runs, ai_autoreply_disabled, or a conversation's assigned_agent_id (spec §11 — no cancellation source)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.fromCalls).not.toContain("flow_runs");
    expect(h.state.fromCalls).not.toContain("ai_autoreply_disabled");
    // The wait branch returns immediately after the insert — it never
    // even reads `conversations` (where assigned_agent_id lives), let
    // alone writes to it.
    expect(h.state.fromCalls).not.toContain("conversations");
  });
});

describe("remove_tag before wait — the follow-up rule's own pattern (spec §6/§11.B)", () => {
  it("removing the tag does not delete or otherwise touch the pending execution it created", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    // Mirrors the real rule: remove_tag runs first (so the tag can retrigger
    // this automation later), THEN wait enqueues the durable follow-up.
    h.state.steps = [
      removeTagStep(0, "PROGRAMAR_PRUEBAS_ENVIO"),
      waitStep(1, 10, "hours"),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    // The tag really was removed...
    expect(h.state.contactTagDeletes).toEqual([
      { contactId: "c1", tagId: "PROGRAMAR_PRUEBAS_ENVIO" },
    ]);
    // ...and the wait step that ran right after it still enqueued its pending
    // row, resuming from the position AFTER wait (index 2).
    expect(h.state.pendingInserts).toHaveLength(1);
    expect(h.state.pendingInserts[0]).toMatchObject({
      next_step_position: 2,
      status: "pending",
    });
    // remove_tag's implementation (src/lib/automations/engine.ts's
    // 'remove_tag' case) only ever issues a delete against contact_tags —
    // it has no reference to automation_pending_executions at all, so
    // there is no code path by which running it could cancel a pending
    // wait row (this one, or any other).
  });
});

describe("P0 contact blocking — race: automation already running when the contact gets blocked", () => {
  it("blocked right before the wait step: no pending row is enqueued, so unblocking later has nothing old to resume", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      removeTagStep(0, "PROGRAMAR_PRUEBAS_ENVIO"),
      waitStep(1, 10, "hours"),
    ];
    // Contacts-select call sequence: #1 = runAutomationsForTrigger's own
    // ownership guard, #2 = the per-step recheck before step 0, #3 = the
    // per-step recheck before step 1 (the wait). Block starting at #3 —
    // the contact was still fine when step 0 ran, then got blocked right
    // before the wait would have been scheduled.
    h.state.blockContactFromCall = 3;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.pendingInserts).toHaveLength(0);
  });

  it("blocked mid-run: the next non-wait side-effect step is never executed", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      removeTagStep(0, "TAG_A"),
      removeTagStep(1, "TAG_B"),
    ];
    // Same call numbering as above: #3 is the recheck before step 1.
    h.state.blockContactFromCall = 3;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    // Step 0 (TAG_A) ran before the contact was blocked; step 1 (TAG_B)
    // must never run once it is.
    expect(h.state.contactTagDeletes).toEqual([{ contactId: "c1", tagId: "TAG_A" }]);
  });

  it("logs the stop as an auditable 'skipped' step with status=partial, not a noisy technical failure", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];
    // Call #1 is runAutomationsForTrigger's own ownership guard (must
    // still see not-blocked here so it actually creates the log via
    // executeAutomation); call #2 is the per-step recheck before step
    // 0 — block from there so even the FIRST step never runs.
    h.state.blockContactFromCall = 2;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.pendingInserts).toHaveLength(0);
    expect(h.state.logUpdates).toHaveLength(1);
    expect(h.state.logUpdates[0]).toMatchObject({ status: "partial", error_message: "contact_blocked" });
    const steps = h.state.logUpdates[0].steps_executed as Array<{ status: string; detail?: string }>;
    expect(steps).toEqual([{ step_id: "wait-0", step_type: "wait", status: "skipped", detail: "contact_blocked" }]);
  });

  it("FAIL CLOSED — a transient error checking contact state stops the run instead of continuing", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      removeTagStep(0, "PROGRAMAR_PRUEBAS_ENVIO"),
      waitStep(1, 10, "hours"),
    ];
    // Same call numbering as the tests above: #3 is the recheck before
    // step 1 (the wait). The SELECT itself fails there, rather than
    // returning blocked=true — must still stop, never fall through to
    // "well, we don't know, so keep going."
    h.state.contactsSelectErrorFromCall = 3;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    // No pending row for the wait step that never got to run...
    expect(h.state.pendingInserts).toHaveLength(0);
    // ...step 0 (which ran before the failure) did its thing, but
    // nothing after the failed check did.
    expect(h.state.contactTagDeletes).toEqual([
      { contactId: "c1", tagId: "PROGRAMAR_PRUEBAS_ENVIO" },
    ]);
    // Auditable, not silently swallowed: a real technical failure
    // (as opposed to the graceful 'partial'/contact_blocked stop)
    // reads status=failed with a distinct, stable detail.
    expect(h.state.logUpdates).toHaveLength(1);
    expect(h.state.logUpdates[0]).toMatchObject({
      status: "failed",
      error_message: "contact_state_check_failed",
    });
    const steps = h.state.logUpdates[0].steps_executed as Array<{ status: string; detail?: string }>;
    expect(steps.at(-1)).toEqual({
      step_id: "wait-1",
      step_type: "wait",
      status: "failed",
      detail: "contact_state_check_failed",
    });
  });
});

describe("P0 contact blocking — wait scheduling is atomic with the contact's blocked state (TOCTOU close)", () => {
  it("A. a wait with a contactId schedules via the RPC, never a direct insert", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.scheduleWaitCalls).toHaveLength(1);
    expect(h.state.scheduleWaitCalls[0]).toMatchObject({
      p_automation_id: "a1",
      p_account_id: ACCOUNT,
      p_contact_id: "c1",
      p_next_step_position: 1,
    });
    // The RPC is the ONLY thing that touches automation_pending_executions
    // here — no separate .from('automation_pending_executions').insert(...).
    expect(h.state.fromCalls).not.toContain("automation_pending_executions");
    expect(h.state.pendingInserts).toHaveLength(1);
  });

  it("B. RPC reports the contact isn't eligible (blocked / not found) -> no pending, no steps after, auditable stop", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];
    h.state.scheduleWaitBlocked = true;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.pendingInserts).toHaveLength(0);
    expect(h.state.logUpdates).toHaveLength(1);
    expect(h.state.logUpdates[0]).toMatchObject({ status: "partial", error_message: "contact_blocked" });
    const steps = h.state.logUpdates[0].steps_executed as Array<{ status: string; detail?: string }>;
    expect(steps).toEqual([{ step_id: "wait-0", step_type: "wait", status: "skipped", detail: "contact_blocked" }]);
  });

  it("C. RPC fails technically -> fail closed, no pending, status=failed with a stable detail", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];
    h.state.scheduleWaitError = { message: "connection reset" };

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.pendingInserts).toHaveLength(0);
    expect(h.state.logUpdates).toHaveLength(1);
    expect(h.state.logUpdates[0]).toMatchObject({ status: "failed", error_message: "wait_schedule_failed" });
    const steps = h.state.logUpdates[0].steps_executed as Array<{ status: string; detail?: string }>;
    expect(steps).toEqual([{ step_id: "wait-0", step_type: "wait", status: "failed", detail: "wait_schedule_failed" }]);
  });

  it("D. RPC succeeds -> continues with the exact prior wait semantics (status=partial, waiting detail)", async () => {
    h.state.owned = { id: "c1", blocked: false };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.pendingInserts).toHaveLength(1);
    expect(h.state.logUpdates).toHaveLength(1);
    expect(h.state.logUpdates[0]).toMatchObject({ status: "partial" });
    const steps = h.state.logUpdates[0].steps_executed as Array<{ status: string; detail?: string }>;
    expect(steps).toEqual([
      { step_id: "wait-0", step_type: "wait", status: "success", detail: "waiting 10 hours" },
    ]);
  });

  it("a wait with NO contactId keeps using the plain direct insert (contact blocking doesn't apply)", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [waitStep(0, 10, "hours")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: null,
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(h.state.scheduleWaitCalls).toHaveLength(0);
    expect(h.state.fromCalls).toContain("automation_pending_executions");
  });
});

describe("resumePendingExecution — processes a due row (spec §11.C)", () => {
  it("resumes from next_step_position and depends only on the pending row's own fields", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      // Position 0 would have been "wait" in the real automation; the
      // pending row already recorded next_step_position=1, so only this
      // step is fetched (`.gte('position', 1)`).
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      // conversation_id pre-supplied so the resumed step never needs to
      // query `conversations` — keeps this test focused on the resume
      // mechanics rather than conversation lookup.
      context: { conversation_id: "conv-1" },
      claim_token: "tok-default",
    });

    expect(h.state.fromCalls).toContain("automation_steps");
    // No `flow_runs`, no `ai_autoreply_disabled` — a resumed wait is
    // driven purely by run_at/status on its own row, never by
    // inbox/agent/AI state. (It DOES now check `contacts.blocked` —
    // see the P0 contact-blocking tests below.)
    expect(h.state.fromCalls).not.toContain("flow_runs");
    expect(h.state.fromCalls).not.toContain("ai_autoreply_disabled");
  });
});

describe("resumePendingExecution — P0 contact blocking", () => {
  it("a blocked contact never runs the resumed steps, and is marked done (not failed, not left pending)", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.owned = { id: "c1", blocked: true };
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-default",
    });

    // automation_steps IS fetched (executeStepsFrom's per-step guard
    // runs inside its loop, after the read-only steps query) — but no
    // step actually executes: no send, no side effect.
    expect(mockEngineSendText).not.toHaveBeenCalled();
    // Never left pending, never marked failed — 'done' so it can never
    // be picked up again, including after a future unblock.
    expect(h.state.pendingStatusUpdates).toEqual([{ id: "pending-1", status: "done" }]);
  });

  it("a non-blocked contact still resumes normally (no false positive)", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.owned = { id: "c1", blocked: false };
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-default",
    });

    expect(h.state.fromCalls).toContain("automation_steps");
    // D. NORMAL — pending still running, contact not blocked: resume
    // proceeds exactly as before, all the way to actually sending.
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
  });
});

describe("resumePendingExecution — P0 durable cancellation token (pending.status, not contacts.blocked)", () => {
  it("B. CLAIMED -> BLOCKED -> UNBLOCKED: a fresh pending re-read of status=done refuses to revive, even though the contact is blocked=false again", async () => {
    h.state.automations = [tagAddedAutomation()];
    // The contact was unblocked before this resume ran — if the code
    // looked at contacts.blocked instead of the pending row's own
    // status, it would wrongly conclude "safe to proceed."
    h.state.owned = { id: "c1", blocked: false };
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];
    // block_contact_internal already flipped this pending row to
    // 'done' while it was 'running' — the durable cancellation token.
    h.state.freshPendingRow = {
      id: "pending-1",
      status: "done",
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
    };

    // The cron's own (now-stale) view of the row it originally claimed.
    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-default",
    });

    expect(h.state.fromCalls).not.toContain("automation_steps");
    expect(mockEngineSendText).not.toHaveBeenCalled();
    expect(h.state.pendingInserts).toHaveLength(0);
    // Must not re-mark it — it's already terminal; resumePendingExecution's
    // revalidation returns before ever calling markPending itself.
    expect(h.state.pendingStatusUpdates).toHaveLength(0);
  });

  it("C. CANCEL DURING RESUME: step 0 runs, then the pending flips to done before step 1 — step 1 never runs", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.owned = { id: "c1", blocked: false };
    h.state.steps = [
      removeTagStep(0, "TAG_A"),
      {
        id: "s-resumed-1",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];

    // Starts valid/running (so resumePendingExecution's own outer
    // revalidation passes and step 0 gets a chance to run)...
    h.state.freshPendingRow = {
      id: "pending-1",
      status: "running",
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
    };
    // ...but a concurrent block_contact_internal call flips it to
    // 'done' between step 0 and step 1. Fresh-read call sequence:
    // #1 = resumePendingExecution's own outer revalidation, #2 = the
    // per-step guard before step 0 (remove_tag) — both still see
    // 'running' — #3 = the per-step guard before step 1
    // (send_message), where it flips to 'done'.
    h.state.pendingDoneFromCall = 3;

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 0,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-default",
    });

    expect(h.state.contactTagDeletes).toEqual([{ contactId: "c1", tagId: "TAG_A" }]);
    expect(mockEngineSendText).not.toHaveBeenCalled();
  });
});

describe("send_media step — reuses the Flows engineSendMedia (spec §11.F/§11.G)", () => {
  it("maps step_config onto engineSendMedia's args, including the ManyChat bridge field", async () => {
    h.state.owned = { id: "c1" };
    h.state.conversationLookup = { id: "conv-1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      sendMediaStep(0, {
        media_type: "image",
        media_url: "https://cdn.example.com/combo.png",
        caption: "Combo XTD",
        manychat_bridge_flow_ns: "content2026abc123",
      }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(mockEngineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        contactId: "c1",
        kind: "image",
        link: "https://cdn.example.com/combo.png",
        caption: "Combo XTD",
        manychatBridgeFlowNs: "content2026abc123",
      }),
    );
  });

  it("throws before sending when media_url is missing (tenant/config guard, spec §11.I)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [sendMediaStep(0, { media_type: "image", media_url: "" })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "PROGRAMAR_PRUEBAS_ENVIO" },
    });

    expect(mockEngineSendMedia).not.toHaveBeenCalled();
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "send_media needs media_url",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Meta 131056 durable retry — PHASE 3
// (docs/META_131056_AUTOMATION_RETRY_AUDIT.md)
// ---------------------------------------------------------------------------

function baseAutomation() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function metaError(overrides: Partial<ConstructorParameters<typeof MetaApiError>[0]> = {}): MetaApiError {
  return new MetaApiError({
    message: "(#131056) pair rate limit hit",
    code: 131056,
    httpStatus: 400,
    ...overrides,
  });
}

function outboundStepConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "hi" };
    case "send_media":
      return { media_type: "image", media_url: "https://example.com/x.jpg" };
    case "send_buttons":
      return { kind: "buttons", body: "Pick one", buttons: [{ id: "a", title: "A" }] };
    case "send_list":
      return { kind: "list", body: "Pick one", button_label: "Choose", sections: [{ rows: [{ id: "a", title: "A" }] }] };
    case "send_template":
      return { template_name: "hello_world" };
    default:
      throw new Error(`outboundStepConfig: unhandled type ${type}`);
  }
}

function outboundStep(
  type: "send_message" | "send_media" | "send_buttons" | "send_list" | "send_template",
  position: number,
  parentStepId: string | null,
  branch: "yes" | "no" | null,
) {
  return {
    id: `${type}-${position}-${branch ?? "root"}`,
    automation_id: "a1",
    step_type: type,
    position,
    parent_step_id: parentStepId,
    branch,
    step_config: outboundStepConfig(type),
  };
}

function mockForOutboundType(type: string) {
  switch (type) {
    case "send_message":
      return mockEngineSendText;
    case "send_media":
      return mockEngineSendMedia;
    case "send_buttons":
    case "send_list":
      return mockEngineSendInteractive;
    case "send_template":
      return mockEngineSendTemplate;
    default:
      throw new Error(`mockForOutboundType: unhandled type ${type}`);
  }
}

/** Thin wrapper around resumePendingExecution with sane defaults, so
 *  each Phase 3 test only has to override what it actually cares about. */
async function resumePending(overrides: {
  id: string
  parent_step_id: string | null
  branch: "yes" | "no" | null
  next_step_position: number
  log_id?: string
  context?: Record<string, unknown>
  /** Meta 131056 durable retry, Phase 3.1 — defaults to the SAME token
   *  the mock's `withRetryDefaults`/update-ownership-check fall back to
   *  when a fixture doesn't set one explicitly ("tok-default"), so
   *  every pre-existing caller of this helper keeps working unchanged.
   *  Tests exercising claim/lease ownership pass a real, differing
   *  token explicitly. */
  claim_token?: string
}) {
  await resumePendingExecution({
    automation_id: "a1",
    user_id: "u1",
    account_id: ACCOUNT,
    contact_id: "c1",
    log_id: overrides.log_id ?? "log1",
    context: overrides.context ?? {},
    id: overrides.id,
    parent_step_id: overrides.parent_step_id,
    branch: overrides.branch,
    next_step_position: overrides.next_step_position,
    claim_token: overrides.claim_token ?? "tok-default",
  });
}

describe("Meta 131056 durable retry — scheduling on failure (Phase 3)", () => {
  it("T1: send_message hitting Meta 131056 schedules a durable retry (retry_count=1) for the SAME step position, log partial", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];
    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(h.state.scheduleRetryCalls).toHaveLength(1);
    const call = h.state.scheduleRetryCalls[0];
    expect(call.p_retry_count).toBe(1);
    expect(call.p_retry_reason).toBe("meta_pair_rate_limit");
    expect(call.p_retry_step_id).toBe("send-0-root");
    // SAME step, not +1 — a retry repeats the exact step, unlike `wait`.
    expect(call.p_next_step_position).toBe(0);

    const pendingInsert = h.state.pendingInserts[0];
    expect(pendingInsert.retry_count).toBe(1);
    expect(pendingInsert.retry_reason).toBe("meta_pair_rate_limit");
    expect(pendingInsert.retry_step_id).toBe("send-0-root");

    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "partial" }));
    const allSteps = h.state.logUpdates.flatMap(
      (u) => (u.steps_executed as { step_id: string; status: string; detail?: string }[] | undefined) ?? [],
    );
    const retryResult = allSteps.find((r) => r.status === "retry_scheduled");
    expect(retryResult).toBeTruthy();
    expect(retryResult!.detail).toMatch(/Meta rate limit \(131056\) — retry 1\/5 scheduled for/);
    // Never leaks sensitive detail into the step result.
    expect(retryResult!.detail).not.toMatch(/token|Bearer|access_token/i);
  });

  it.each(["send_message", "send_media", "send_buttons", "send_list", "send_template"] as const)(
    "T-SEND-TYPES: %s hitting Meta 131056 schedules a durable retry",
    async (type) => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [outboundStep(type, 0, null, null)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(mockForOutboundType(type) as any).mockRejectedValueOnce(metaError());

      await runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: { conversation_id: "conv-1" },
      });

      expect(h.state.scheduleRetryCalls).toHaveLength(1);
      expect(h.state.scheduleRetryCalls[0].p_retry_count).toBe(1);
      expect(h.state.scheduleRetryCalls[0].p_next_step_position).toBe(0);
      expect(h.state.scheduleRetryCalls[0].p_retry_step_id).toBe(`${type}-0-root`);
    },
  );
});

describe("Meta 131056 — NO retry cases (section 28)", () => {
  const scenarios: Array<{ name: string; error: unknown }> = [
    { name: "429 WITHOUT code 131056", error: metaError({ code: 4, httpStatus: 429 }) },
    { name: "131030 (recipient not allowed)", error: metaError({ code: 131030, httpStatus: 400 }) },
    { name: "500", error: metaError({ code: 2, httpStatus: 500 }) },
    { name: "a plain Error whose text happens to mention 131056", error: new Error("(#131056) pair rate limit hit") },
    { name: "a TypeError from a failed fetch", error: new TypeError("fetch failed") },
    { name: "DB post-send persistence failure", error: new Error("sent to Meta but DB insert failed: unique violation") },
    { name: "a ManyChat-style plain Error", error: new Error("ManyChat send failed: 500") },
  ];

  it.each(scenarios)("$name -> terminal failed, schedule_automation_retry_if_contact_active NEVER called", async ({ error }) => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];
    vi.mocked(mockEngineSendText).mockRejectedValueOnce(error);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(h.state.scheduleRetryCalls).toHaveLength(0);
    expect(h.state.pendingInserts).toHaveLength(0);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  describe("non-outbound step throwing a MetaApiError(131056)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("send_webhook is NOT in the outbound send set — never retries even if it throws a MetaApiError", async () => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [
        {
          id: "wh1",
          automation_id: "a1",
          step_type: "send_webhook",
          position: 0,
          parent_step_id: null,
          branch: null,
          // A literal public IP — isDeliverableUrl's isIP() short-circuit
          // means no real DNS lookup happens in this test.
          step_config: { url: "http://8.8.8.8/hook" },
        },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw metaError();
        }),
      );

      await runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: {},
      });

      expect(h.state.scheduleRetryCalls).toHaveLength(0);
      expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "failed" }));
    });
  });
});

describe("Meta 131056 retry lifecycle 1..5 then terminal (section 14)", () => {
  it("initial failure -> retries 1..5, each repeating the SAME step; the 6th failure is terminal with NO 6th pending", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });
    expect(h.state.pendingInserts).toHaveLength(1);
    expect(h.state.pendingInserts[0].retry_count).toBe(1);

    for (let n = 2; n <= 5; n++) {
      const prev = h.state.pendingInserts[h.state.pendingInserts.length - 1];
      h.state.freshPendingRow = {
        id: `pending-${n}`,
        status: "running",
        automation_id: "a1",
        account_id: ACCOUNT,
        contact_id: "c1",
        retry_count: prev.retry_count,
        retry_reason: prev.retry_reason,
        retry_step_id: prev.retry_step_id,
      };
      vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
      await resumePending({
        id: `pending-${n}`,
        parent_step_id: prev.parent_step_id as string | null,
        branch: prev.branch as "yes" | "no" | null,
        next_step_position: prev.next_step_position as number,
        context: (prev.context as Record<string, unknown>) ?? {},
      });
      expect(h.state.pendingInserts).toHaveLength(n);
      expect(h.state.pendingInserts[n - 1].retry_count).toBe(n);
      expect(h.state.pendingInserts[n - 1].next_step_position).toBe(0);
    }

    // The 6th attempt: resume the retry_count=5 pending; it fails Meta
    // 131056 AGAIN. 5 is NOT < MAX_META_RATE_LIMIT_RETRIES(5), so no 6th
    // pending is created — this is terminal.
    const pending5 = h.state.pendingInserts[4];
    h.state.freshPendingRow = {
      id: "pending-final",
      status: "running",
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
      retry_count: pending5.retry_count,
      retry_reason: pending5.retry_reason,
      retry_step_id: pending5.retry_step_id,
    };
    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await resumePending({
      id: "pending-final",
      parent_step_id: pending5.parent_step_id as string | null,
      branch: pending5.branch as "yes" | "no" | null,
      next_step_position: pending5.next_step_position as number,
      context: (pending5.context as Record<string, unknown>) ?? {},
    });

    // Still exactly 5 retry pendings ever created — no 6th.
    expect(h.state.pendingInserts).toHaveLength(5);
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-final", status: "done" });
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "(#131056) pair rate limit hit" }),
    );
  });

  it("retry succeeding on its first attempt (retry_count=1) continues normally, no further pending", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });
    const pending1 = h.state.pendingInserts[0];

    h.state.freshPendingRow = {
      id: "pending-1",
      status: "running",
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
      retry_count: pending1.retry_count,
      retry_reason: pending1.retry_reason,
      retry_step_id: pending1.retry_step_id,
    };
    // Default mock implementation resolves successfully — no mockRejectedValueOnce this time.
    await resumePending({
      id: "pending-1",
      parent_step_id: pending1.parent_step_id as string | null,
      branch: pending1.branch as "yes" | "no" | null,
      next_step_position: pending1.next_step_position as number,
      context: (pending1.context as Record<string, unknown>) ?? {},
    });

    expect(h.state.pendingInserts).toHaveLength(1); // no 2nd retry pending
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });
});

describe("Meta 131056 — retry_count is per-step, not per-run (section 11)", () => {
  it("step 10 retries twice then succeeds; step 11's own first failure schedules retry_count=1, NOT 3", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      { ...sendMessageStep(10, null, null) },
      { ...sendMessageStep(11, null, null) },
    ];

    // step 10: initial failure -> retry 1.
    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });
    const pendingR1 = h.state.pendingInserts[0];
    expect(pendingR1.retry_count).toBe(1);
    expect(pendingR1.next_step_position).toBe(10);

    // resume retry 1 of step 10 -> fails again -> retry 2.
    h.state.freshPendingRow = {
      id: "pending-r1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: pendingR1.retry_count, retry_reason: pendingR1.retry_reason, retry_step_id: pendingR1.retry_step_id,
    };
    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await resumePending({
      id: "pending-r1",
      parent_step_id: pendingR1.parent_step_id as string | null,
      branch: pendingR1.branch as "yes" | "no" | null,
      next_step_position: pendingR1.next_step_position as number,
      context: (pendingR1.context as Record<string, unknown>) ?? {},
    });
    const pendingR2 = h.state.pendingInserts[1];
    expect(pendingR2.retry_count).toBe(2);
    expect(pendingR2.next_step_position).toBe(10);

    // resume retry 2 of step 10 -> SUCCEEDS this time -> the loop
    // continues in the SAME executeStepsFrom call to step 11 (position
    // 11), which is a FRESH step that has never been retried. It fails
    // Meta 131056 for the first time here.
    h.state.freshPendingRow = {
      id: "pending-r2", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: pendingR2.retry_count, retry_reason: pendingR2.retry_reason, retry_step_id: pendingR2.retry_step_id,
    };
    // Both step 10 and step 11 are `send_message` — they share the SAME
    // engineSendText mock, called in order within this ONE resume: the
    // 1st call is step 10 (must resolve — its retry succeeds), the 2nd
    // is step 11 (must reject — its own first-ever failure). Queuing
    // only a rejection here would be consumed by step 10 itself (the
    // earlier call), not step 11 — both must be queued, in this order.
    vi.mocked(mockEngineSendText)
      .mockResolvedValueOnce({ whatsapp_message_id: "m-step10-success" })
      .mockRejectedValueOnce(metaError());
    // Step 10's send succeeds, then step 11's send is attempted in the
    // SAME executeStepsFrom call — Phase 4's preventive Meta pacing
    // (AUTOMATION_META_OUTBOUND_PACING_MS) now waits between them
    // exactly like a real burst would. Fake timers so this test doesn't
    // really sleep ~1.5s (see the dedicated "Meta pacing" describe
    // block below for tests that specifically exercise the wait
    // duration itself).
    vi.useFakeTimers();
    try {
      const resumePromise = resumePending({
        id: "pending-r2",
        parent_step_id: pendingR2.parent_step_id as string | null,
        branch: pendingR2.branch as "yes" | "no" | null,
        next_step_position: pendingR2.next_step_position as number,
        context: (pendingR2.context as Record<string, unknown>) ?? {},
      });
      await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS);
      await resumePromise;
    } finally {
      vi.useRealTimers();
    }

    expect(h.state.pendingInserts).toHaveLength(3);
    const pendingStep11 = h.state.pendingInserts[2];
    // MUST be 1, never 3 — step 11 has never been retried before; it
    // must not inherit step 10's accumulated retry count.
    expect(pendingStep11.retry_count).toBe(1);
    expect(pendingStep11.next_step_position).toBe(11);
    expect(pendingStep11.retry_step_id).toBe("send-11-root");
  });
});

describe("Meta 131056 — exact-step validation at resume / edit-in-flight (section 26)", () => {
  function retryPendingFixture() {
    return {
      id: "pending-A",
      status: "running",
      automation_id: "a1",
      account_id: ACCOUNT,
      contact_id: "c1",
      retry_count: 2,
      retry_reason: "meta_pair_rate_limit",
      retry_step_id: "send-3-root",
    };
  }

  it("A: the step at that position was REPLACED by a different step UUID -> fail closed, log failed, detail retry_target_changed", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    // Position 3 now holds a DIFFERENT step (id "send-3-root-NEW") — the
    // retry's own recorded id no longer exists at all.
    h.state.steps = [{ ...sendMessageStep(3, null, null), id: "send-3-root-NEW" }, updateStepAt(4)];
    h.state.freshPendingRow = retryPendingFixture();

    await resumePending({ id: "pending-A", parent_step_id: null, branch: null, next_step_position: 3 });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "retry_target_changed" }),
    );
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-A", status: "done" });
    expect(mockEngineSendText).not.toHaveBeenCalled();
    expect(h.state.updateCalls).toHaveLength(0); // no ancestor continuation either
  });

  it("B: the step was DELETED entirely -> fail closed the same way", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [updateStepAt(4)]; // "send-3-root" no longer exists at all
    h.state.freshPendingRow = retryPendingFixture();

    await resumePending({ id: "pending-A", parent_step_id: null, branch: null, next_step_position: 3 });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "retry_target_changed" }),
    );
    expect(mockEngineSendText).not.toHaveBeenCalled();
  });

  it("C: the step still exists but was MOVED to a different position -> fail closed", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    // "send-3-root" is real, but now lives at position 5, not 3.
    h.state.steps = [{ ...sendMessageStep(3, null, null), position: 5 }];
    h.state.freshPendingRow = retryPendingFixture();

    await resumePending({ id: "pending-A", parent_step_id: null, branch: null, next_step_position: 3 });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "retry_target_changed" }),
    );
    expect(mockEngineSendText).not.toHaveBeenCalled();
  });

  it("D: the step still exists at the right position but its parent/branch changed -> fail closed", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    // Same id, same position — but now nested under a condition instead
    // of at the root, which is what the pending row still claims.
    h.state.steps = [{ ...sendMessageStep(3, "some-other-condition", "yes") }];
    h.state.freshPendingRow = retryPendingFixture();

    await resumePending({ id: "pending-A", parent_step_id: null, branch: null, next_step_position: 3 });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "retry_target_changed" }),
    );
    expect(mockEngineSendText).not.toHaveBeenCalled();
  });

  it("does NOT fail closed when the step genuinely still matches everything recorded (regression guard)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(3, null, null)]; // id "send-3-root", unchanged
    h.state.freshPendingRow = retryPendingFixture();

    await resumePending({
      id: "pending-A",
      parent_step_id: null,
      branch: null,
      next_step_position: 3,
      context: { conversation_id: "conv-1" },
    });

    // Proceeds normally — sends, succeeds (default mock resolves).
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("inconsistent retry metadata on the fresh row (retry_count>0 but retry_reason/retry_step_id missing) fails closed", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(3, null, null)];
    h.state.freshPendingRow = {
      id: "pending-bad", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: 2, retry_reason: null, retry_step_id: null,
    };

    await resumePending({ id: "pending-bad", parent_step_id: null, branch: null, next_step_position: 3 });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "retry_metadata_inconsistent" }),
    );
    expect(mockEngineSendText).not.toHaveBeenCalled();
  });
});

describe("Meta 131056 — ancestor unwind interacting with retry (sections 24-25)", () => {
  it("single condition: retry the send, remove_tag and root-next wait for the resume, then everything runs exactly once", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      sendMessageStep(0, "cond1", "yes"),
      { ...removeTagStep(1, "tag-x"), parent_step_id: "cond1", branch: "yes" },
      updateStepAt(1), // root next
    ];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    // Retry scheduled for the send inside the branch; nothing after it
    // (in the branch OR at root) has run yet.
    expect(h.state.scheduleRetryCalls).toHaveLength(1);
    expect(h.state.scheduleRetryCalls[0].p_parent_step_id).toBe("cond1");
    expect(h.state.scheduleRetryCalls[0].p_branch).toBe("yes");
    expect(h.state.contactTagDeletes).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "partial" }));

    const pendingRetry = h.state.pendingInserts[0];
    h.state.freshPendingRow = {
      id: "pending-retry", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: pendingRetry.retry_count, retry_reason: pendingRetry.retry_reason, retry_step_id: pendingRetry.retry_step_id,
    };
    // Resume: the SAME step now succeeds (default mock).
    await resumePending({
      id: "pending-retry",
      parent_step_id: pendingRetry.parent_step_id as string,
      branch: pendingRetry.branch as "yes",
      next_step_position: pendingRetry.next_step_position as number,
      context: (pendingRetry.context as Record<string, unknown>) ?? {},
    });

    // 2 calls total across the whole test: the initial failed attempt
    // (during dispatch) + the successful resume — the step is never
    // skipped or double-counted.
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    // remove_tag runs (branch completes)...
    expect(h.state.contactTagDeletes).toHaveLength(1);
    // ...ancestor unwind continues root's next step...
    expect(h.state.updateCalls).toHaveLength(1);
    // ...and the log finishes success.
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("2 nested conditions: retry the deepest send, resume climbs through both ancestors, each side effect exactly once", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"), // A, "cond1"
      { id: "condB", automation_id: "a1", step_type: "condition", position: 0, parent_step_id: "cond1", branch: "yes", step_config: { subject: "message_content", value: "hello" } },
      { ...sendMessageStep(0, "condB", "yes") },
      { ...updateStepAt(1), parent_step_id: "condB", branch: "yes", step_config: { field: "company", value: "after-send" } },
      { ...updateStepAt(1), parent_step_id: "cond1", branch: "yes", step_config: { field: "company", value: "after-B" } },
      updateStepAt(1), // root, "after A"
    ];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    expect(h.state.scheduleRetryCalls).toHaveLength(1);
    expect(h.state.scheduleRetryCalls[0].p_parent_step_id).toBe("condB");
    expect(h.state.updateCalls).toHaveLength(0);

    const pendingRetry = h.state.pendingInserts[0];
    h.state.freshPendingRow = {
      id: "pending-deep-retry", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: pendingRetry.retry_count, retry_reason: pendingRetry.retry_reason, retry_step_id: pendingRetry.retry_step_id,
    };
    await resumePending({
      id: "pending-deep-retry",
      parent_step_id: pendingRetry.parent_step_id as string,
      branch: pendingRetry.branch as "yes",
      next_step_position: pendingRetry.next_step_position as number,
      context: (pendingRetry.context as Record<string, unknown>) ?? {},
    });

    // "after send" (inside B) + "after B" (inside A) + "after A" (root) —
    // 3 update_contact_field writes total, each exactly once.
    expect(h.state.updateCalls).toHaveLength(3);
    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({ status: "success" }));
  });
});

// ---------------------------------------------------------------------------
// Meta 131056 durable retry, PHASE 3.1 — claim/lease ownership. Cron-level
// claim/reclaim races (CR-01..CR-04, CR-09) are covered in
// src/app/api/automations/cron/route.test.ts, since claiming itself happens
// there. The tests below cover the engine's OWN half of the contract: once
// resumePendingExecution/executeStepsFrom/markPending are handed a
// claim_token, they must honor it exactly like pendingExecutionId — a
// mismatch stops a stale worker cold, and it can never overwrite a row a
// newer worker now owns. See docs/META_131056_AUTOMATION_RETRY_AUDIT.md
// section "Fase 3.1".
// ---------------------------------------------------------------------------
describe("Meta 131056 — claim/lease ownership (Phase 3.1)", () => {
  it("CR-05: a reclaimed row's OLD token fails the per-step isPendingExecutionStillRunning check mid-resume — the step never runs", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];
    h.state.owned = { id: "c1", blocked: false };
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-old",
    };
    // Call #1 = resumePendingExecution's own initial revalidation (still
    // sees "tok-old" — the caller's own claim is still valid AT THAT
    // POINT, so it proceeds). Call #2 = the per-step
    // isPendingExecutionStillRunning check for the one step in this
    // scope — simulate ANOTHER worker reclaiming the row's expired lease
    // (a brand-new token) exactly then, between the initial check and
    // this step actually running.
    h.state.reclaimClaimTokenFromCall = 2;

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-old",
    });

    // The stale worker's copy of the token no longer matches the row's
    // CURRENT claim — the step it was about to run never runs.
    expect(mockEngineSendText).not.toHaveBeenCalled();
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "partial", error_message: "pending_execution_cancelled" }),
    );
  });

  it("CR-06: after that same reclaim, the stale worker's OWN final markPending('done') call cannot modify the new owner's row", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];
    h.state.owned = { id: "c1", blocked: false };
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-old",
    };
    h.state.reclaimClaimTokenFromCall = 2;

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-old",
    });

    // resumePendingExecution still calls markPending(id, 'done', 'tok-old')
    // unconditionally at the end of its own attempt — but the row's
    // CURRENT claim_token is now "tok-reclaimed" (the new owner's), so
    // the ownership-aware UPDATE (`WHERE status='running' AND
    // claim_token='tok-old'`) matches 0 rows. The stale worker can
    // never stomp the new owner's in-flight execution.
    expect(h.state.pendingStatusUpdates).toHaveLength(0);
    expect(h.state.pendingStatusUpdateRejected).toContainEqual({ id: "pending-1", status: "done" });
  });

  it("CR-07: a resume that completes normally (no reclaim) marks the row done AND clears claim_token/lease_expires_at", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];
    h.state.owned = { id: "c1", blocked: false };
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-mine",
    };

    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-mine",
    });

    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-1", status: "done" });
    expect(h.state.pendingStatusUpdatePayloads).toContainEqual({
      id: "pending-1",
      status: "done",
      claim_token: null,
      lease_expires_at: null,
    });
  });

  it("CR-10: a normal wait resume (retry_count=0) enforces claim_token ownership through the exact same initial gate as a retry resume", async () => {
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      {
        id: "s-resumed",
        automation_id: "a1",
        step_type: "send_message",
        position: 1,
        parent_step_id: null,
        step_config: { text: "Gracias por tu compra" },
      },
    ];
    h.state.owned = { id: "c1", blocked: false };
    // A plain wait pending (retry_count 0, defaulted by withRetryDefaults)
    // now owned by a DIFFERENT worker's token.
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-current-owner",
    };

    // This caller's own (stale) view of the token it once claimed.
    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-stale",
    });

    // Rejected at resumePendingExecution's own INITIAL gate — never even
    // reaches automation_steps, exactly like the durable-cancellation
    // (status='done') case already covered above, just via claim_token
    // instead of status.
    expect(h.state.fromCalls).not.toContain("automation_steps");
    expect(mockEngineSendText).not.toHaveBeenCalled();
    expect(h.state.pendingStatusUpdates).toHaveLength(0);
    expect(h.state.pendingStatusUpdateRejected).toHaveLength(0);
  });

  it("CR-11: a Meta 131056 retry resume (retry_count>0) enforces claim_token ownership through the exact same initial gate — no separate claim system", async () => {
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(3, null, null), updateStepAt(4)];
    h.state.owned = { id: "c1" };
    h.state.freshPendingRow = {
      id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: 2, retry_reason: "meta_pair_rate_limit", retry_step_id: "send-3-root",
      claim_token: "tok-current-owner",
    };

    await resumePending({ id: "pending-A", parent_step_id: null, branch: null, next_step_position: 3, claim_token: "tok-stale" });

    // Same code path, same outcome as CR-10 — retry_count has no bearing
    // on whether the ownership gate applies. Never even reaches the
    // exact-step validation (isRetryTargetStillValid), let alone sends.
    expect(h.state.fromCalls).not.toContain("automation_steps");
    expect(mockEngineSendText).not.toHaveBeenCalled();
    expect(h.state.pendingStatusUpdates).toHaveLength(0);
    expect(h.state.pendingStatusUpdateRejected).toHaveLength(0);
  });

  it("CR-12: Pending A resuming into a fresh wait creates Pending B with NO claim metadata; Pending A is marked done under its OWN token", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { id: "a1", account_id: ACCOUNT, user_id: "u1", trigger_type: "new_message_received", trigger_config: {}, is_active: true },
    ];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      sendMessageStep(0, "cond1", "yes"),
      { ...waitStep(1, 10, "minutes"), parent_step_id: "cond1", branch: "yes" }, // Pending A stops here
      { ...waitStep(2, 5, "minutes"), parent_step_id: "cond1", branch: "yes" }, // Pending B created on resume of A
      updateStepAt(1), // root
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    const pendingA = h.state.pendingInserts[0];
    // A freshly-inserted pending row (via the wait scheduler RPC) has no
    // claim/lease yet either — it's only claimed once a cron tick picks
    // it up.
    expect(pendingA.claim_token).toBeUndefined();
    expect(pendingA.lease_expires_at).toBeUndefined();

    h.state.freshPendingRow = {
      id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-A",
    };

    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-A",
    });

    // Pending B: a brand-new row, own lifecycle, no claim metadata yet —
    // completely independent of Pending A's token.
    expect(h.state.pendingInserts).toHaveLength(2);
    const pendingB = h.state.pendingInserts[1];
    expect(pendingB.claim_token).toBeUndefined();
    expect(pendingB.lease_expires_at).toBeUndefined();

    // Pending A marked done under its OWN token — the ownership-aware
    // UPDATE matches because "tok-A" is still the row's current claim.
    expect(h.state.pendingStatusUpdates).toContainEqual({ id: "pending-A", status: "done" });
    expect(h.state.pendingStatusUpdatePayloads).toContainEqual({
      id: "pending-A",
      status: "done",
      claim_token: null,
      lease_expires_at: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Preventive Meta pacing — PHASE 4
// (docs/META_131056_AUTOMATION_RETRY_AUDIT.md section "Fase 4")
//
// Every test here uses vi.useFakeTimers() + vi.advanceTimersByTimeAsync so
// none of them actually sleep — each demonstrates the ACTUAL wait duration
// (or absence of one) by advancing the fake clock to just-under and then
// to the expected threshold, never by only checking that "some sleep
// function was called". `advanceClockOnContactUpdateMs` (see the shared
// mock's `contacts` update branch above) simulates ordinary processing
// time elapsing between two sends via an update_contact_field step, using
// vi.setSystemTime rather than a nested vi.advanceTimersByTimeAsync call —
// see that field's own doc for why.
// ---------------------------------------------------------------------------
describe("Meta pacing (Phase 4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("PC-01: the first Meta send of an execution has 0 delay", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];

    vi.useFakeTimers();
    // No timer advance at all — if the engine incorrectly paced the
    // very first send, this would hang forever waiting on a fake timer
    // nothing ever advances, and the test would time out.
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
  });

  it("PC-02: two immediate Meta sends — the second waits the FULL 1500ms since the first completed", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), sendMessageStep(1, null, null)];

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    await dispatch;
  });

  it("PC-03: 1000ms already elapsed via an in-between step — the second send waits only the REMAINING ~500ms", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), updateStepAt(1), sendMessageStep(2, null, null)];
    h.state.advanceClockOnContactUpdateMs = 1000;

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    // Let step0's send + step1's clock-jumping update settle first.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1); // still waiting
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2); // now sent
    await dispatch;
  });

  it("PC-04: >=1500ms already elapsed via an in-between step — 0 additional delay", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), updateStepAt(1), sendMessageStep(2, null, null)];
    h.state.advanceClockOnContactUpdateMs = AUTOMATION_META_OUTBOUND_PACING_MS + 100;

    vi.useFakeTimers();
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    // No advance beyond letting microtasks settle — the whole dispatch
    // resolves with no pending fake timer left over.
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
  });

  it("PC-05: Meta send -> non-send step -> Meta send: the second is still paced (full interval, since the in-between step took no simulated time)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), updateStepAt(1), sendMessageStep(2, null, null)];
    // No advanceClockOnContactUpdateMs set — the in-between step is
    // instantaneous in fake time, so the full interval still applies.

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    await dispatch;
  });

  it("PC-06: Meta send -> condition YES -> Meta send: SAME runtime, second is paced", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      sendMessageStep(0, null, null),
      conditionStep(1, "message_content", "hello"),
      sendMessageStep(0, "cond1", "yes"),
    ];

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });

    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    await dispatch;
  });

  it("PC-07: Meta send inside a nested branch -> ancestor unwind -> Meta send at root: second is paced against the first, across the resume", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      conditionStep(0, "message_content", "hello"),
      { ...waitStep(0, 10, "minutes"), parent_step_id: "cond1", branch: "yes" }, // Pending stops here, nothing sent yet
      sendMessageStep(1, "cond1", "yes"), // "B" — first Meta send of the resume
      sendMessageStep(1, null, null), // "C" — root's next step, reached via ancestor unwind
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "hello", conversation_id: "conv-1" },
    });
    expect(mockEngineSendText).not.toHaveBeenCalled();
    const pendingA = h.state.pendingInserts[0];
    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    vi.useFakeTimers();
    const resume = resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes",
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-default",
    });

    // B sends immediately (first of this fresh resume).
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    // C (root, via ancestor unwind) must wait the full interval since B.
    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    await resume;
  });

  it("PC-08: a retry resume's own successful send paces the NEXT (fresh) step in the same scope", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), sendMessageStep(1, null, null)];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });
    const pendingRetry = h.state.pendingInserts[0];
    expect(pendingRetry.retry_count).toBe(1);
    h.state.freshPendingRow = {
      id: "pending-retry", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      retry_count: pendingRetry.retry_count, retry_reason: pendingRetry.retry_reason, retry_step_id: pendingRetry.retry_step_id,
    };
    // Isolate the resume's own call count from the initial (rejected)
    // attempt above — mockClear() only wipes call history, never a
    // queued mockRejectedValueOnce/mockResolvedValueOnce (already fully
    // consumed here anyway), so it's safe mid-test.
    vi.mocked(mockEngineSendText).mockClear();

    vi.useFakeTimers();
    const resume = resumePending({
      id: "pending-retry",
      parent_step_id: pendingRetry.parent_step_id as string | null,
      branch: pendingRetry.branch as "yes" | "no" | null,
      next_step_position: pendingRetry.next_step_position as number,
      context: (pendingRetry.context as Record<string, unknown>) ?? {},
    });

    // Retry's own send (step 0) — first of this resume, 0 delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    // Step 1 (fresh, never retried) must still be paced against it.
    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    await resume;
  });

  it("PC-09: the first Meta send after a wait resume has NO delay inherited from before the wait", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [
      sendMessageStep(0, null, null), // pre-wait send
      { ...waitStep(1, 10, "minutes"), parent_step_id: null, branch: null },
      sendMessageStep(2, null, null), // post-wait send (on resume)
    ];

    vi.useFakeTimers();
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    const pendingA = h.state.pendingInserts[0];
    h.state.freshPendingRow = { id: "pending-A", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1" };

    // No timer advance — a fresh runtime means the post-wait send has
    // NOTHING to pace against, so it must go out immediately. If the
    // runtime had incorrectly persisted across the Pending boundary,
    // this would hang waiting on a fake timer nothing advances.
    await resumePendingExecution({
      id: "pending-A",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: (pendingA.log_id as string) ?? "log1",
      parent_step_id: pendingA.parent_step_id as string,
      branch: pendingA.branch as "yes" | "no" | null,
      next_step_position: pendingA.next_step_position as number,
      context: (pendingA.context as Record<string, unknown>) ?? {},
      claim_token: "tok-default",
    });

    expect(mockEngineSendText).toHaveBeenCalledTimes(2);
  });

  describe("ManyChat-bridged account (transport-awareness)", () => {
    const originalTransport = process.env.WHATSAPP_OUTBOUND_TRANSPORT;
    const originalBridgeAccount = process.env.MANYCHAT_INGEST_ACCOUNT_ID;

    beforeEach(() => {
      process.env.WHATSAPP_OUTBOUND_TRANSPORT = "manychat";
      process.env.MANYCHAT_INGEST_ACCOUNT_ID = ACCOUNT;
    });

    afterEach(() => {
      if (originalTransport === undefined) delete process.env.WHATSAPP_OUTBOUND_TRANSPORT;
      else process.env.WHATSAPP_OUTBOUND_TRANSPORT = originalTransport;
      if (originalBridgeAccount === undefined) delete process.env.MANYCHAT_INGEST_ACCOUNT_ID;
      else process.env.MANYCHAT_INGEST_ACCOUNT_ID = originalBridgeAccount;
    });

    it("PC-10: send_message on a ManyChat-bridged account — no delay, no Meta timestamp", async () => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [sendMessageStep(0, null, null), sendMessageStep(1, null, null)];

      vi.useFakeTimers();
      // No advance at all — two ManyChat sends back to back must both
      // complete with zero pacing.
      await runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: { conversation_id: "conv-1" },
      });

      expect(mockEngineSendText).toHaveBeenCalledTimes(2);
    });

    it("PC-11: send_media on a ManyChat-bridged account — no delay, no Meta timestamp", async () => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [
        sendMediaStep(0, { media_type: "image", media_url: "https://example.com/a.jpg" }),
        { ...sendMediaStep(1, { media_type: "image", media_url: "https://example.com/b.jpg" }), id: "media-1" },
      ];

      vi.useFakeTimers();
      await runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: { conversation_id: "conv-1" },
      });

      expect(mockEngineSendMedia).toHaveBeenCalledTimes(2);
    });

    it("PC-12: send_template on a ManyChat-bridged account STILL paces — Meta-only regardless of transport", async () => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [outboundStep("send_template", 0, null, null), { ...outboundStep("send_template", 1, null, null), id: "send_template-1" }];

      vi.useFakeTimers();
      const dispatch = runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: { conversation_id: "conv-1" },
      });

      await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
      expect(mockEngineSendTemplate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockEngineSendTemplate).toHaveBeenCalledTimes(2);
      await dispatch;
    });

    it("PC-15: a ManyChat send between two Meta-only sends does NOT reset the Meta pacing clock", async () => {
      h.state.owned = { id: "c1" };
      h.state.automations = [baseAutomation()];
      h.state.steps = [
        outboundStep("send_template", 0, null, null), // Meta-only template #1
        sendMessageStep(1, null, null), // ManyChat (this account is the bridge)
        { ...outboundStep("send_template", 2, null, null), id: "send_template-2" }, // Meta-only template #2
      ];

      vi.useFakeTimers();
      const dispatch = runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        contactId: "c1",
        context: { conversation_id: "conv-1" },
      });

      // Template #1 (0 delay, first ever) + the ManyChat send_message
      // (0 delay, never Meta-bound) both settle without any advance.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockEngineSendTemplate).toHaveBeenCalledTimes(1);
      expect(mockEngineSendText).toHaveBeenCalledTimes(1);

      // Template #2 must still respect the interval since template #1 —
      // the ManyChat send in between did NOT push the clock forward or
      // erase it.
      await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
      expect(mockEngineSendTemplate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockEngineSendTemplate).toHaveBeenCalledTimes(2);
      await dispatch;
    });
  });

  it("PC-13: send_buttons is paced", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [outboundStep("send_buttons", 0, null, null), { ...outboundStep("send_buttons", 1, null, null), id: "send_buttons-1" }];

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendInteractive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendInteractive).toHaveBeenCalledTimes(2);
    await dispatch;
  });

  it("PC-14: send_list is paced", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [outboundStep("send_list", 0, null, null), { ...outboundStep("send_list", 1, null, null), id: "send_list-1" }];

    vi.useFakeTimers();
    const dispatch = runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS - 1);
    expect(mockEngineSendInteractive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEngineSendInteractive).toHaveBeenCalledTimes(2);
    await dispatch;
  });

  it("PC-16: a first Meta send failing 131056 never records a completed-send timestamp; retry scheduling is unaffected by pacing", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null)];

    vi.mocked(mockEngineSendText).mockRejectedValueOnce(metaError());
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    // Exactly the same retry-scheduling shape as Phase 3 — pacing adds
    // no new field, no new call, no changed retry_count/run_at logic.
    expect(h.state.scheduleRetryCalls).toHaveLength(1);
    expect(h.state.scheduleRetryCalls[0].p_retry_count).toBe(1);
    expect(h.state.pendingInserts).toHaveLength(1);
    expect(h.state.pendingInserts[0].retry_count).toBe(1);
  });

  it("PC-17: losing claim ownership DURING the pacing sleep stops the second send from ever going out", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), sendMessageStep(1, null, null)];
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-mine",
    };
    // pendingSelectCount call sequence for this resume: #1 = resumePendingExecution's
    // own initial revalidation, #2 = gate A for step 0, #3 = gate A for
    // step 1, #4 = the NEW post-pacing recheck (section 10) once step
    // 1's sleep resolves. Reclaiming exactly at #4 simulates another
    // worker taking over WHILE this worker was asleep pacing, not
    // before.
    h.state.reclaimClaimTokenFromCall = 4;

    vi.useFakeTimers();
    const resume = resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 0,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-mine",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1); // step 0 sent
    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS);
    await resume;

    // Step 1 never sent — the post-sleep ownership recheck caught the
    // reclaim and stopped the worker cold.
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
  });

  it("PC-18: the contact being blocked DURING the pacing sleep stops the second send from ever going out", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [baseAutomation()];
    h.state.steps = [sendMessageStep(0, null, null), sendMessageStep(1, null, null)];
    h.state.freshPendingRow = {
      id: "pending-1", status: "running", automation_id: "a1", account_id: ACCOUNT, contact_id: "c1",
      claim_token: "tok-mine",
    };
    // Same call numbering as PC-17 — block_contact_internal flips this
    // pending row to 'done' (the durable cancellation token) exactly at
    // the post-pacing recheck, simulating the block happening WHILE
    // this worker was asleep.
    h.state.pendingDoneFromCall = 4;

    vi.useFakeTimers();
    const resume = resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      user_id: "u1",
      account_id: ACCOUNT,
      contact_id: "c1",
      log_id: "log-1",
      parent_step_id: null,
      branch: null,
      next_step_position: 0,
      context: { conversation_id: "conv-1" },
      claim_token: "tok-mine",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOMATION_META_OUTBOUND_PACING_MS);
    await resume;

    expect(mockEngineSendText).toHaveBeenCalledTimes(1);
  });
});
