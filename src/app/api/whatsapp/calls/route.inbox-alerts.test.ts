import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "keyler-account";
const CUSTOMER = "51911122233";
const BUSINESS = "740434745820831";
const CONVERSATION = "a3000000-0000-4000-8000-000000000004";
const PILOT_BUSINESS_PHONE = "51980942247";
const h = vi.hoisted(() => ({
  configPhone: "740434745820831",
  configStatus: "connected",
  sessions: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async () => ({ accountId: "keyler-account", userId: "pilot-agent" })),
  toErrorResponse: vi.fn(() => Response.json({ error: "server error" }, { status: 500 })),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      h.queries.push({ table, filters });
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return q;
        },
        in: (key: string, values: unknown[]) => {
          filters[key] = values;
          return q;
        },
        order: () => q,
        limit: async () => ({ data: h.sessions, error: null }),
        maybeSingle: async () => ({
          data: table === "whatsapp_config"
            ? {
                phone_number_id: h.configPhone,
                status: h.configStatus,
                access_token: "not-read",
                messaging_account_id: null,
              }
            : null,
          error: null,
        }),
      };
      return q;
    },
  }),
}));

import { GET } from "./route";

const original = {
  enabled: process.env.WHATSAPP_CALLING_ENABLED,
  numbers: process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS,
  allContacts: process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS,
};

function call(overrides: Record<string, unknown> = {}) {
  return {
    phone_number_id: BUSINESS,
    customer_phone: CUSTOMER,
    customer_bsuid: "PE.123456789",
    customer_parent_bsuid: null,
    conversation_id: CONVERSATION,
    customer_name: "Cliente de prueba",
    created_at: "2026-11-23T04:00:00Z",
    direction: "USER_INITIATED",
    state: "offered",
    terminal_status: null,
    signal_status: null,
    accepted_by_user_id: null,
    rejected_by_user_id: null,
    ended_by_user_id: null,
    session_sdp_expires_at: new Date(Date.now() + 45_000).toISOString(),
    claimed_by_user_id: null,
    claim_expires_at: null,
    ...overrides,
  };
}

const request = (query = "inbox_alerts=1") =>
  new Request("https://wacrm.test/api/whatsapp/calls?" + query);

beforeEach(() => {
  h.configPhone = BUSINESS;
  h.configStatus = "connected";
  h.sessions = [call()];
  h.queries = [];
  process.env.WHATSAPP_CALLING_ENABLED = "true";
  process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = BUSINESS;
  process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = "true";
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("WHATSAPP_CALLING_ENABLED", original.enabled);
  restore("WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS", original.numbers);
  restore("WHATSAPP_CALLING_KEYLER_ALL_CONTACTS", original.allContacts);
});

describe("GET /api/whatsapp/calls?inbox_alerts=1", () => {
  it("returns only safe metadata for an eligible live incoming offer", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      calls: [{
        conversation_id: CONVERSATION,
        customer_name: "Cliente de prueba",
        created_at: "2026-11-23T04:00:00Z",
        expires_at: expect.any(String),
      }],
    });
    const lookup = h.queries.find((q) => q.table === "whatsapp_call_sessions");
    expect(lookup?.filters).toMatchObject({
      account_id: ACCOUNT,
      phone_number_id: BUSINESS,
      direction: "USER_INITIATED",
      state: ["offered", "ringing"],
    });
  });

  it("does not reveal identity, phone, SDP or internal claim data", async () => {
    const payload = await (await GET(request())).json();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(CUSTOMER);
    expect(serialized).not.toContain(PILOT_BUSINESS_PHONE);
    expect(serialized).not.toContain("PE.123456789");
    expect(serialized).not.toContain("session_sdp");
    expect(serialized).not.toContain("claimed_by_user_id");
  });

  it("rejects the self-call that caused the real incident, even with a BSUID", async () => {
    h.sessions = [call({ customer_phone: PILOT_BUSINESS_PHONE })];
    const result = await (await GET(request())).json();
    expect(result).toEqual({ calls: [] });
  });

  it("hides expired, claimed-by-other, signaled, terminal and unassociated offers", async () => {
    h.sessions = [
      call({ session_sdp_expires_at: new Date(Date.now() - 1000).toISOString() }),
      call({ claimed_by_user_id: "other-agent", claim_expires_at: new Date(Date.now() + 50000).toISOString() }),
      call({ signal_status: "unknown" }),
      call({ terminal_status: "reserved" }),
      call({ accepted_by_user_id: "pilot-agent" }),
      call({ conversation_id: null }),
    ];
    expect(await (await GET(request())).json()).toEqual({ calls: [] });
  });

  it("allows BSUID-only callers without a phone but only with pilot enabled", async () => {
    h.sessions = [call({ customer_phone: null })];
    expect((await (await GET(request())).json()).calls).toHaveLength(1);
    process.env.WHATSAPP_CALLING_ENABLED = "false";
    expect(await (await GET(request())).json()).toEqual({ calls: [] });
  });

  it("does not even query sessions for unrelated tenant business numbers", async () => {
    h.configPhone = "99999999999999";
    expect(await (await GET(request())).json()).toEqual({ calls: [] });
    expect(h.queries.some((q) => q.table === "whatsapp_call_sessions")).toBe(false);
  });

  it("does not query sessions when the account's WhatsApp connection is disconnected", async () => {
    h.configStatus = "disconnected";
    expect(await (await GET(request())).json()).toEqual({ calls: [] });
    expect(h.queries.some((q) => q.table === "whatsapp_call_sessions")).toBe(false);
  });

  it("returns 400 for invalid parameter values", async () => {
    const response = await GET(request("inbox_alerts=all"));
    expect(response.status).toBe(400);
  });
});
