import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-contact pause of keyword automation: only the `keyword_match` trigger is gated. Every other trigger type reaches the automation lookup as
// before. Observed through the tables the engine reads: a paused keyword_match never queries `automations`.

const h = vi.hoisted(() => ({
  state: {
    paused: new Map<string, boolean>(),
    settingsError: null as { code?: string; message: string } | null,
    reads: [] as string[],
    automationQueries: [] as unknown[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;
  return {
    supabaseAdmin: () => ({
      rpc: () => Promise.resolve({ data: null, error: null }),
      from: (table: string) => {
        state.reads.push(table);
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (k: string, v: unknown) => ((filters[k] = v), b),
          maybeSingle: () => {
            if (table === "contacts") return Promise.resolve({ data: { id: filters.id, blocked: false, phone: "51900000000" }, error: null });
            if (table === "contact_automation_settings") {
              if (state.settingsError) return Promise.resolve({ data: null, error: state.settingsError });
              const paused = state.paused.get(filters.contact_id as string);
              return Promise.resolve({ data: paused === undefined ? null : { keyword_automations_paused: paused }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then: (res: (v: unknown) => unknown) => {
            if (table === "automations") state.automationQueries.push({ ...filters });
            return Promise.resolve({ data: [], error: null }).then(res);
          },
        };
        return b;
      },
    }),
  };
});
vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(), engineSendTemplate: vi.fn(), engineSendInteractive: vi.fn(), engineSendMedia: vi.fn(),
}));
vi.mock("@/lib/whatsapp/bsuid-flow-auth", () => ({ getDbPilotScopes: vi.fn(async () => []) }));

import { runAutomationsForTrigger } from "./engine";

const ACCOUNT = "acct-1";
const run = (triggerType: string, contactId = "angelo") =>
  runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: triggerType as never, contactId, context: { message_text: "amoladora" } });

beforeEach(() => {
  h.state.paused = new Map();
  h.state.settingsError = null;
  h.state.reads = [];
  h.state.automationQueries = [];
});

describe("runAutomationsForTrigger — keyword pause", () => {
  it("6a. active contact: keyword_match looks up its automations", async () => {
    await run("keyword_match");
    expect(h.state.automationQueries).toHaveLength(1);
  });

  it("6b. paused contact: keyword_match never reaches the automations", async () => {
    h.state.paused.set("angelo", true);
    await run("keyword_match");
    expect(h.state.automationQueries).toHaveLength(0);
  });

  it.each(["new_message_received", "first_inbound_message", "new_contact_created", "interactive_reply", "tag_added"])(
    "7. paused contact: %s is not gated",
    async (trigger) => {
      h.state.paused.set("angelo", true);
      await run(trigger);
      expect(h.state.automationQueries).toHaveLength(1);
      expect(h.state.reads).not.toContain("contact_automation_settings");
    },
  );

  it("10. isolation: Angelo paused, Keyler still runs keyword_match", async () => {
    h.state.paused.set("angelo", true);
    await run("keyword_match", "angelo");
    await run("keyword_match", "keyler");
    expect(h.state.automationQueries).toHaveLength(1);
  });

  it("a failed pause read fails closed for keyword_match", async () => {
    h.state.settingsError = { code: "XX000", message: "boom" };
    await run("keyword_match");
    expect(h.state.automationQueries).toHaveLength(0);
  });

  it("a migration not applied yet (missing table) means not paused", async () => {
    h.state.settingsError = { code: "42P01", message: "relation does not exist" };
    await run("keyword_match");
    expect(h.state.automationQueries).toHaveLength(1);
  });
});
