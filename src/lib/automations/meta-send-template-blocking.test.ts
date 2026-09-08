import { describe, it, expect, vi, beforeEach } from "vitest";

// P0 — BLOQUEO INTERNO DE CONTACTOS. `sendTemplateViaMeta` (behind
// `engineSendTemplate`) is the one Automations sender that does NOT
// delegate to `@/lib/flows/meta-send` (already covered by
// meta-send.test.ts there) — template sends are Meta-only with no
// ManyChat bridge. This file proves it independently refuses a
// blocked contact before ever calling Meta.

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.tpl" })),
  state: {
    contactRow: { id: "ct-1", phone: "+15551234567", blocked: false } as Record<
      string,
      unknown
    > | null,
    configRow: { phone_number_id: "pn-1", access_token: "token" } as Record<
      string,
      unknown
    > | null,
    insertCalls: [] as Record<string, unknown>[],
  },
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: (...a: unknown[]) =>
    (h.sendTemplateMessage as unknown as (...x: unknown[]) => unknown)(...a),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v,
}));

vi.mock("@/lib/whatsapp/template-body", () => ({
  resolveTemplateRow: async () => ({ row: null }),
  templateContentText: () => "rendered body",
}));

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: h.state.contactRow, error: null }),
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "whatsapp_config") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: h.state.configRow, error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.insertCalls.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "conversations") {
        return { update: () => ({ eq: async () => ({ error: null }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

// Not exercised by this file, but meta-send.ts imports it at module
// load — stub it out so the import doesn't drag in the real Flows
// senders (and their own transport/decrypt dependencies).
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}));

import { engineSendTemplate } from "./meta-send";
import { ContactBlockedError } from "@/lib/contacts/blocking";

const ARGS = {
  accountId: "acct-1",
  userId: "user-1",
  conversationId: "conv-1",
  contactId: "ct-1",
  templateName: "order_update",
  language: "en_US",
  params: ["Acme"],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.contactRow = { id: "ct-1", phone: "+15551234567", blocked: false };
  h.state.configRow = { phone_number_id: "pn-1", access_token: "token" };
  h.state.insertCalls = [];
  h.sendTemplateMessage.mockResolvedValue({ messageId: "wamid.tpl" });
});

describe("engineSendTemplate — blocked-contact guard", () => {
  it("refuses a blocked contact before calling Meta", async () => {
    h.state.contactRow = { id: "ct-1", phone: "+15551234567", blocked: true };
    await expect(engineSendTemplate(ARGS)).rejects.toBeInstanceOf(ContactBlockedError);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("sends normally for a non-blocked contact (no false positive)", async () => {
    const result = await engineSendTemplate(ARGS);
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(result.whatsapp_message_id).toBe("wamid.tpl");
  });
});
