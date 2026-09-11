import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTIVE_LIMITS,
  MetaApiError,
  parseRetryAfterSeconds,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
} from "./meta-api";
import { classifyMetaSendError } from "./meta-error-classify";
import { isRecipientNotAllowedError } from "./phone-utils";

// All assertions in this file run BEFORE the network call. We stub fetch
// to a never-resolving mock so a test that accidentally falls through to
// the request body would hang (and fail) rather than silently hit
// graph.facebook.com.
const neverFetch = () =>
  new Promise<Response>(() => {
    /* intentionally never resolves */
  });

const BASE_ARGS = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  bodyText: "Body text",
} as const;

describe("sendInteractiveButtons — validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an empty buttons array", async () => {
    await expect(
      sendInteractiveButtons({ ...BASE_ARGS, buttons: [] }),
    ).rejects.toThrow(/1-3 buttons/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxButtons} buttons (Meta cap)`, async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
          { id: "c", title: "C" },
          { id: "d", title: "D" },
        ],
      }),
    ).rejects.toThrow(/1-3 buttons/);
  });

  it("rejects a button title longer than 20 chars (Meta cap)", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          { id: "a", title: "x".repeat(INTERACTIVE_LIMITS.buttonTitleMaxLength + 1) },
        ],
      }),
    ).rejects.toThrow(/exceeds 20 chars/);
  });

  it("rejects a button missing its id", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [{ id: "", title: "Choose me" }],
      }),
    ).rejects.toThrow(/missing id/);
  });

  it("rejects an empty body text", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        bodyText: "",
        buttons: [{ id: "a", title: "A" }],
      }),
    ).rejects.toThrow(/requires bodyText/);
  });

  it("rejects a header text over the limit", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        headerText: "x".repeat(INTERACTIVE_LIMITS.headerTextMaxLength + 1),
        buttons: [{ id: "a", title: "A" }],
      }),
    ).rejects.toThrow(/headerText exceeds/);
  });

  it("sends the right payload shape when all inputs are valid", async () => {
    let captured: { url: string; body: unknown; method: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url,
          method: init.method ?? "GET",
          body: JSON.parse(String(init.body)),
        };
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.PASS" }] }),
          { status: 200 },
        );
      }),
    );

    const result = await sendInteractiveButtons({
      ...BASE_ARGS,
      headerText: "Hello",
      footerText: "Tap one",
      buttons: [
        { id: "yes", title: "Yes" },
        { id: "no", title: "No" },
      ],
    });

    expect(result).toEqual({ messageId: "wamid.PASS" });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("test-phone/messages");
    expect(captured!.body).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1234567890",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Body text" },
        header: { type: "text", text: "Hello" },
        footer: { text: "Tap one" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "yes", title: "Yes" } },
            { type: "reply", reply: { id: "no", title: "No" } },
          ],
        },
      },
    });
  });
});

describe("sendInteractiveList — validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ROW = { id: "r1", title: "Row 1" };

  it("rejects zero sections", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [],
      }),
    ).rejects.toThrow(/1-10 sections/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across sections (Meta cap)`, async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i}`,
      title: `Row ${i}`,
    }));
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [{ rows }],
      }),
    ).rejects.toThrow(/1-10 rows total/);
  });

  it("rejects a row title longer than 24 chars (Meta cap)", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [
          {
            rows: [
              {
                id: "r1",
                title: "x".repeat(INTERACTIVE_LIMITS.listRowTitleMaxLength + 1),
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/exceeds 24 chars/);
  });

  it("rejects duplicate row ids across sections", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [
          { rows: [{ id: "dupe", title: "First" }] },
          { rows: [{ id: "dupe", title: "Second" }] },
        ],
      }),
    ).rejects.toThrow(/duplicate row id/);
  });

  it("rejects an empty buttonLabel", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "",
        sections: [{ rows: [ROW] }],
      }),
    ).rejects.toThrow(/requires a buttonLabel/);
  });

  it("sends the right payload shape when valid", async () => {
    let captured: { body: unknown } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.LIST" }] }),
          { status: 200 },
        );
      }),
    );

    const result = await sendInteractiveList({
      ...BASE_ARGS,
      buttonLabel: "Open menu",
      sections: [
        {
          title: "Orders",
          rows: [
            { id: "order_1", title: "Order #1", description: "€12" },
            { id: "order_2", title: "Order #2" },
          ],
        },
      ],
    });

    expect(result).toEqual({ messageId: "wamid.LIST" });
    expect(captured).not.toBeNull();
    expect(captured!.body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Body text" },
        action: {
          button: "Open menu",
          sections: [
            {
              title: "Orders",
              rows: [
                { id: "order_1", title: "Order #1", description: "€12" },
                { id: "order_2", title: "Order #2" },
              ],
            },
          ],
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// P0.1 — WhatsApp voice notes. `voice` on `sendMediaMessage` is what
// actually makes Meta render an OGG/Opus audio message as a voice-note
// bubble; without it, even a valid Opus file renders as a plain audio
// attachment. Must never leak onto a non-audio kind, and normal audio
// (no flag) must keep sending exactly the pre-existing wire shape.
// ---------------------------------------------------------------------------
describe("sendMediaMessage — audio / voice note wire shape", () => {
  const MEDIA_BASE = {
    phoneNumberId: "test-phone",
    accessToken: "test-token",
    to: "1234567890",
    link: "https://cdn.example.com/voice.ogg",
  } as const;

  function stubSuccessfulSend() {
    let captured: { body: { audio?: Record<string, unknown>; image?: Record<string, unknown> } } | null =
      null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ messages: [{ id: "wamid.AUDIO" }] }), {
          status: 200,
        });
      }),
    );
    return () => captured;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normal audio (no voice flag) sends { link } only — unchanged from today", async () => {
    const getCaptured = stubSuccessfulSend();
    await sendMediaMessage({ ...MEDIA_BASE, kind: "audio" });
    expect(getCaptured()!.body.audio).toEqual({ link: MEDIA_BASE.link });
  });

  it("voice=true sends { link, voice: true }", async () => {
    const getCaptured = stubSuccessfulSend();
    await sendMediaMessage({ ...MEDIA_BASE, kind: "audio", voice: true });
    expect(getCaptured()!.body.audio).toEqual({ link: MEDIA_BASE.link, voice: true });
  });

  it("voice=false is indistinguishable from omitted — no voice key at all", async () => {
    const getCaptured = stubSuccessfulSend();
    await sendMediaMessage({ ...MEDIA_BASE, kind: "audio", voice: false });
    expect(getCaptured()!.body.audio).toEqual({ link: MEDIA_BASE.link });
    expect(getCaptured()!.body.audio).not.toHaveProperty("voice");
  });

  it("never sends caption or filename for audio, even as a voice note", async () => {
    const getCaptured = stubSuccessfulSend();
    await sendMediaMessage({
      ...MEDIA_BASE,
      kind: "audio",
      voice: true,
      caption: "hello there",
      filename: "note.ogg",
    });
    expect(getCaptured()!.body.audio).toEqual({ link: MEDIA_BASE.link, voice: true });
  });

  it("ignores voice=true for a non-audio kind — never sent on the wire", async () => {
    const getCaptured = stubSuccessfulSend();
    await sendMediaMessage({
      ...MEDIA_BASE,
      kind: "image",
      voice: true,
      link: "https://cdn.example.com/pic.jpg",
    });
    expect(getCaptured()!.body.image).toEqual({ link: "https://cdn.example.com/pic.jpg" });
    expect(getCaptured()!.body.image).not.toHaveProperty("voice");
  });
});

// ---------------------------------------------------------------------------
// Meta 131056 retry design, PHASE 2 — throwMetaError now throws MetaApiError
// (structured metadata) instead of a plain Error. Tested through public
// senders (sendTextMessage), never by exporting throwMetaError itself —
// see docs/META_131056_AUTOMATION_RETRY_AUDIT.md's Phase 2 section.
// ---------------------------------------------------------------------------
describe("throwMetaError -> MetaApiError (Meta 131056 Phase 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function metaErrorResponse(
    body: unknown,
    init: { status: number; headers?: Record<string, string> },
  ): Response {
    return new Response(JSON.stringify(body), { status: init.status, headers: init.headers });
  }

  const SEND_ARGS = { phoneNumberId: "p1", accessToken: "t1", to: "1234567890", text: "hi" };

  async function captureError(): Promise<unknown> {
    try {
      await sendTextMessage(SEND_ARGS);
      throw new Error("expected sendTextMessage to reject");
    } catch (err) {
      return err;
    }
  }

  it("CP-META-01: a structured 131056 error preserves every field, with the real HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        metaErrorResponse(
          {
            error: {
              message: "(#131056) pair rate limit hit",
              code: 131056,
              error_subcode: 123,
              type: "OAuthException",
              fbtrace_id: "trace-test",
              error_data: { details: "test" },
            },
          },
          { status: 400, headers: { "Retry-After": "120" } },
        ),
      ),
    );

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    const err = caught as MetaApiError;
    expect(err.message).toBe("(#131056) pair rate limit hit");
    expect(err.code).toBe(131056);
    expect(err.errorSubcode).toBe(123);
    expect(err.type).toBe("OAuthException");
    expect(err.httpStatus).toBe(400);
    expect(err.retryAfterSeconds).toBe(120);
    expect(err.fbtraceId).toBe("trace-test");
    expect(err.errorData).toEqual({ details: "test" });

    expect(classifyMetaSendError(err)).toEqual({
      retryable: true,
      reason: "meta_pair_rate_limit",
      code: 131056,
      retryAfterSeconds: 120,
    });
  });

  it("CP-META-02: a 429 WITHOUT code 131056 is a MetaApiError, but the classifier says not retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaErrorResponse({ error: { message: "Too many requests", code: 4 } }, { status: 429 })),
    );

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).httpStatus).toBe(429);
    expect((caught as MetaApiError).code).toBe(4);
    expect(classifyMetaSendError(caught)).toEqual({ retryable: false, reason: "not_retryable", code: 4 });
  });

  it("CP-META-03: a 500 is a MetaApiError, but the classifier says not retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaErrorResponse({ error: { message: "Internal error", code: 2 } }, { status: 500 })),
    );

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).httpStatus).toBe(500);
    expect(classifyMetaSendError(caught).retryable).toBe(false);
  });

  it("CP-META-04: an invalid JSON body falls back to the caller's fallback message, httpStatus preserved, code undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 503 })));

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    const err = caught as MetaApiError;
    expect(err.message).toBe("Meta API error: 503");
    expect(err.httpStatus).toBe(503);
    expect(err.code).toBeUndefined();
    expect(err.errorSubcode).toBeUndefined();
    expect(err.fbtraceId).toBeUndefined();
  });

  it("CP-META-04b: an empty body (no content at all) also falls back cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).message).toBe("Meta API error: 400");
    expect((caught as MetaApiError).code).toBeUndefined();
  });

  it("CP-META-05: an invalid Retry-After header yields retryAfterSeconds=undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        metaErrorResponse(
          { error: { message: "x", code: 1 } },
          { status: 400, headers: { "Retry-After": "not-a-number-or-date" } },
        ),
      ),
    );

    const caught = await captureError();
    expect((caught as MetaApiError).retryAfterSeconds).toBeUndefined();
  });

  it("CP-META-06: an HTTP-date Retry-After in the future yields the correct positive retryAfterSeconds", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const future = new Date(now.getTime() + 90_000).toUTCString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        metaErrorResponse(
          { error: { message: "x", code: 1 } },
          { status: 400, headers: { "Retry-After": future } },
        ),
      ),
    );
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const caught = await captureError();
      // 90s exactly at `now`; allow the tiny bit of fake-timer/promise
      // scheduling slack that toUTCString's 1s truncation can introduce.
      expect((caught as MetaApiError).retryAfterSeconds).toBeGreaterThanOrEqual(89);
      expect((caught as MetaApiError).retryAfterSeconds).toBeLessThanOrEqual(90);
    } finally {
      vi.useRealTimers();
    }
  });

  it("CP-META-07: a 131030 error preserves .message so isRecipientNotAllowedError keeps working unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        metaErrorResponse(
          { error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030 } },
          { status: 400 },
        ),
      ),
    );

    const caught = await captureError();
    expect(caught).toBeInstanceOf(MetaApiError);
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(isRecipientNotAllowedError(msg)).toBe(true);
    expect(classifyMetaSendError(caught).retryable).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Section 14 — MetaApiError must behave exactly like a normal Error for
  // every callsite that only ever reads `.message` / does `instanceof Error`.
  // ---------------------------------------------------------------------
  it("MetaApiError behaves as a real Error subclass (instanceof, name, String())", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaErrorResponse({ error: { message: "boom", code: 1 } }, { status: 400 })),
    );

    const caught = await captureError();
    expect(caught instanceof Error).toBe(true);
    expect(caught instanceof MetaApiError).toBe(true);
    expect((caught as Error).name).toBe("MetaApiError");
    expect(String(caught)).toContain("boom");
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses a plain delta-seconds value", () => {
    expect(parseRetryAfterSeconds("120")).toBe(120);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("parses a future HTTP-date relative to an injected `now`", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(parseRetryAfterSeconds(new Date("2026-01-01T00:02:00Z").toUTCString(), now)).toBe(120);
  });

  it("returns undefined for a past HTTP-date", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(parseRetryAfterSeconds(new Date("2025-12-31T23:00:00Z").toUTCString(), now)).toBeUndefined();
  });

  it("returns undefined for missing, empty, negative, or garbage values", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds("   ")).toBeUndefined();
    expect(parseRetryAfterSeconds("-5")).toBeUndefined();
    expect(parseRetryAfterSeconds("not-a-date-or-number")).toBeUndefined();
  });
});
