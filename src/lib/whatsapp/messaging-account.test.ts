import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGING_ACCOUNT_ID_PATTERN,
  messagingAccountField,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
} from "./meta-api";

// Meta's new account model: `messaging_account_id` names the account billed for a send. It must appear ONLY when configured, so account L and
// account A (no value) keep sending byte-for-byte what they sent before this change.

const MA = "1111111111111111";
const COMMON = { phoneNumberId: "2222222222222222", accessToken: "tok", to: "51999999999" } as const;

function captureFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

type Sender = (extra: { messagingAccountId?: string | null }) => Promise<unknown>;
const senders: Record<string, Sender> = {
  text: (e) => sendTextMessage({ ...COMMON, text: "hola", ...e }),
  image: (e) => sendMediaMessage({ ...COMMON, kind: "image", link: "https://x/y.jpg", caption: "c", ...e }),
  audio: (e) => sendMediaMessage({ ...COMMON, kind: "audio", link: "https://x/y.ogg", voice: true, ...e }),
  template: (e) => sendTemplateMessage({ ...COMMON, templateName: "pedido", language: "es", params: ["A"], ...e }),
  reaction: (e) => sendReactionMessage({ ...COMMON, targetMessageId: "wamid.T", emoji: "👍", ...e }),
  buttons: (e) => sendInteractiveButtons({ ...COMMON, bodyText: "Elige", buttons: [{ id: "a", title: "A" }], ...e }),
  list: (e) =>
    sendInteractiveList({
      ...COMMON,
      bodyText: "Elige",
      buttonLabel: "Ver",
      sections: [{ title: "S", rows: [{ id: "r1", title: "R1" }] }],
      ...e,
    }),
};

describe("messagingAccountField", () => {
  it("returns nothing for null, undefined, empty and blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(messagingAccountField(v)).toEqual({});
  });
  it("returns the id (trimmed) when it is digits only", () => {
    expect(messagingAccountField(MA)).toEqual({ messaging_account_id: MA });
    expect(messagingAccountField(` ${MA} `)).toEqual({ messaging_account_id: MA });
  });
  it("throws on anything that is not 5-25 digits instead of dropping it (a dropped id would be billed to somebody else)", () => {
    for (const v of ["abc", "1234", "12345678901234567890123456", "123 456", "1111111111111111; DROP", "-1111111111111111"]) {
      expect(() => messagingAccountField(v)).toThrow(/Invalid messaging_account_id/);
    }
  });
  it("shares its pattern with the database CHECK (5-25 digits)", () => {
    expect(MESSAGING_ACCOUNT_ID_PATTERN.source).toBe("^\\d{5,25}$");
  });
});

describe.each(Object.keys(senders))("%s send payload", (kind) => {
  it("names the messaging account when the account has one", async () => {
    const calls = captureFetch();
    await senders[kind]({ messagingAccountId: MA });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v21.0/${COMMON.phoneNumberId}/messages`);
    expect(calls[0].body.messaging_account_id).toBe(MA);
    expect(calls[0].body.messaging_product).toBe("whatsapp");
  });

  it("is byte-for-byte the legacy payload when the id is missing, null or empty", async () => {
    const legacyCalls = captureFetch();
    await senders[kind]({});
    const legacy = JSON.stringify(legacyCalls[0].body);
    expect(legacyCalls[0].body).not.toHaveProperty("messaging_account_id");
    for (const v of [undefined, null, ""]) {
      const c = captureFetch();
      await senders[kind]({ messagingAccountId: v });
      expect(JSON.stringify(c[0].body)).toBe(legacy);
    }
  });

  it("adds exactly one key and changes nothing else", async () => {
    const without = captureFetch();
    await senders[kind]({});
    const withId = captureFetch();
    await senders[kind]({ messagingAccountId: MA });
    const { messaging_account_id, ...rest } = withId[0].body;
    expect(messaging_account_id).toBe(MA);
    expect(rest).toEqual(without[0].body);
  });

  it("refuses to send (and never calls Meta) when the stored id is malformed", async () => {
    const calls = captureFetch();
    await expect(senders[kind]({ messagingAccountId: "not-a-number" })).rejects.toThrow(/Invalid messaging_account_id/);
    expect(calls).toHaveLength(0);
  });
});

describe("what is NOT changed", () => {
  it("never leaks the id into the Authorization header or the URL", async () => {
    const seen: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
      }),
    );
    await sendTextMessage({ ...COMMON, text: "hola", messagingAccountId: MA });
    expect(seen[0].url).not.toContain(MA);
    expect(JSON.stringify(seen[0].headers)).not.toContain(MA);
  });
});
