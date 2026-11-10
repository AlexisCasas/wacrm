import { describe, expect, it, vi, afterEach } from "vitest";
import { MetaApiError } from "./meta-api";
import { describeSendError } from "./send-error-diagnostics";

function fetchFailed(code: string, extra: Record<string, unknown> = {}, causeName = "Error"): TypeError {
  const cause = Object.assign(new Error("secret-host.example/token=abc123"), { code, name: causeName, ...extra });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

afterEach(() => vi.useRealTimers());

describe("describeSendError", () => {
  it.each([
    ["ENOTFOUND", "dns", "not_sent"],
    ["EAI_AGAIN", "dns", "not_sent"],
    ["ECONNREFUSED", "connect", "not_sent"],
    ["UND_ERR_CONNECT_TIMEOUT", "connect", "not_sent"],
    ["ENETUNREACH", "connect", "not_sent"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls", "not_sent"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", "unknown"],
    ["UND_ERR_BODY_TIMEOUT", "timeout", "unknown"],
    ["ECONNRESET", "socket_reset", "unknown"],
    ["UND_ERR_SOCKET", "socket_reset", "unknown"],
  ])("classifies fetch failure %s as %s / %s", (code, cls, state) => {
    const d = describeSendError(fetchFailed(code));
    expect(d.error_class).toBe(cls);
    expect(d.sent_state).toBe(state);
    expect(d.cause_code).toBe(code);
  });

  it("treats ETIMEDOUT during connect as not sent, otherwise unknown", () => {
    expect(describeSendError(fetchFailed("ETIMEDOUT", { syscall: "connect" }))).toMatchObject({
      error_class: "connect",
      sent_state: "not_sent",
      syscall: "connect",
    });
    expect(describeSendError(fetchFailed("ETIMEDOUT", { syscall: "read" }))).toMatchObject({
      error_class: "timeout",
      sent_state: "unknown",
    });
  });

  it("finds the code inside an AggregateError cause and nested causes", () => {
    const inner = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([inner], "agg"), { name: "AggregateError" });
    const err = Object.assign(new TypeError("fetch failed"), { cause: agg });
    expect(describeSendError(err)).toMatchObject({ error_class: "connect", cause_code: "ECONNREFUSED" });
    const nested = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("a"), { cause: inner }) });
    expect(describeSendError(nested).cause_code).toBe("ECONNREFUSED");
  });

  it("unknown reason behind 'fetch failed' stays ambiguous", () => {
    expect(describeSendError(new TypeError("fetch failed"))).toEqual(
      expect.objectContaining({ error_class: "network_unknown", sent_state: "unknown" }),
    );
  });

  it("classifies abort/timeout errors as timeout/unknown", () => {
    const err = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(describeSendError(err)).toMatchObject({ error_class: "timeout", sent_state: "unknown" });
  });

  it("maps Meta HTTP errors: 4xx definite rejection, 5xx ambiguous, ids preserved", () => {
    const rejected = new MetaApiError({ message: "bad", httpStatus: 429, code: 131056, errorSubcode: 1, fbtraceId: "AbC_123", retryAfterSeconds: 30 });
    expect(describeSendError(rejected)).toMatchObject({
      error_class: "meta_http",
      sent_state: "not_sent",
      http_status: 429,
      meta_code: 131056,
      meta_subcode: 1,
      fbtrace_id: "AbC_123",
      retry_after_s: 30,
    });
    expect(describeSendError(new MetaApiError({ message: "boom", httpStatus: 503 }))).toMatchObject({ sent_state: "unknown", http_status: 503 });
  });

  it("flags a persistence failure after Meta accepted the message as sent", () => {
    const d = describeSendError(new Error("sent to Meta but DB insert failed: boom"));
    expect(d).toMatchObject({ error_class: "sent_persist_failed", sent_state: "sent" });
  });

  it("anything else is 'other' and conservatively unknown", () => {
    expect(describeSendError(new Error("contact not found for this account"))).toMatchObject({ error_class: "other", sent_state: "unknown" });
    expect(describeSendError(null)).toMatchObject({ error_class: "other", sent_state: "unknown" });
    expect(describeSendError("string")).toMatchObject({ error_class: "other", sent_state: "unknown" });
  });

  it("never leaks messages, tokens or URLs, and drops unsafe code strings", () => {
    const evil = fetchFailed("ECONNRESET");
    const d = describeSendError(evil);
    const json = JSON.stringify(d);
    expect(json).not.toContain("secret-host");
    expect(json).not.toContain("token");
    expect(json).not.toContain("abc123");
    const unsafe = describeSendError(fetchFailed("connect to 10.0.0.1:443 failed"));
    expect(unsafe.cause_code).toBeUndefined();
    expect(unsafe.error_class).toBe("network_unknown");
    const badTrace = describeSendError(new MetaApiError({ message: "m", httpStatus: 400, fbtraceId: "bad trace with spaces" }));
    expect(badTrace.fbtrace_id).toBeUndefined();
  });

  it("reports elapsed time from the supplied start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
    const start = Date.now();
    vi.setSystemTime(new Date("2026-11-10T18:00:00.300Z"));
    expect(describeSendError(fetchFailed("ECONNRESET"), start).elapsed_ms).toBe(300);
    expect(typeof describeSendError(new Error("x")).process_uptime_s).toBe("number");
  });
});
