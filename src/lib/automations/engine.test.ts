import { describe, it, expect, beforeEach, vi } from "vitest";

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
      if (type === "insert") {
        state.pendingInserts.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (type === "update") {
        const id = ops.filters.find((f) => f[1] === "id")?.[2];
        const status = (ops.payload as { status?: unknown } | undefined)?.status;
        state.pendingStatusUpdates.push({ id, status });
        return { data: null, error: null };
      }
      // The P0 cancellation-token re-checks (resumePendingExecution's
      // own revalidation, and executeStepsFrom's per-step
      // isPendingExecutionStillRunning) both do a plain SELECT by id.
      state.pendingSelectCount += 1;
      if (
        state.freshPendingRow &&
        state.pendingDoneFromCall !== null &&
        state.pendingSelectCount >= state.pendingDoneFromCall
      ) {
        return { data: { ...state.freshPendingRow, status: "done" }, error: null };
      }
      return { data: state.freshPendingRow, error: state.freshPendingRowError };
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
    if (table === "automation_steps") return { data: state.steps, error: null };
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
      gte: () => b,
      is: () => b,
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

import { runAutomationsForTrigger, triggerMatches, resumePendingExecution } from "./engine";
import { engineSendMedia as mockEngineSendMedia, engineSendText as mockEngineSendText } from "./meta-send";
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
  vi.mocked(mockEngineSendMedia).mockClear();
  vi.mocked(mockEngineSendText).mockClear();
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
