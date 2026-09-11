import { describe, expect, it } from "vitest";
import { MetaApiError } from "./meta-api";
import { classifyMetaSendError } from "./meta-error-classify";

function metaError(overrides: Partial<ConstructorParameters<typeof MetaApiError>[0]>): MetaApiError {
  return new MetaApiError({
    message: "error",
    httpStatus: 400,
    ...overrides,
  });
}

describe("classifyMetaSendError", () => {
  it("1. MetaApiError code 131056 -> retryable=true, reason=meta_pair_rate_limit", () => {
    const err = metaError({ message: "(#131056) pair rate limit hit", code: 131056, httpStatus: 400 });
    expect(classifyMetaSendError(err)).toEqual({
      retryable: true,
      reason: "meta_pair_rate_limit",
      code: 131056,
      retryAfterSeconds: undefined,
    });
  });

  it("2. 131056 with retryAfterSeconds propagates it", () => {
    const err = metaError({ code: 131056, httpStatus: 400, retryAfterSeconds: 300 });
    const result = classifyMetaSendError(err);
    expect(result.retryable).toBe(true);
    if (result.retryable) {
      expect(result.retryAfterSeconds).toBe(300);
    }
  });

  it("3. MetaApiError with httpStatus 429 but WITHOUT code 131056 -> false", () => {
    const err = metaError({ code: 4, httpStatus: 429 });
    expect(classifyMetaSendError(err)).toEqual({ retryable: false, reason: "not_retryable", code: 4 });
  });

  it("4. MetaApiError 131030 (recipient not allowed) -> false", () => {
    const err = metaError({ code: 131030, httpStatus: 400 });
    expect(classifyMetaSendError(err).retryable).toBe(false);
  });

  it("5. MetaApiError 500 -> false", () => {
    const err = metaError({ code: 2, httpStatus: 500 });
    expect(classifyMetaSendError(err).retryable).toBe(false);
  });

  it("6. a plain Error whose text happens to mention '131056' -> false (no regex fallback)", () => {
    const err = new Error("(#131056) pair rate limit hit");
    expect(classifyMetaSendError(err)).toEqual({ retryable: false, reason: "not_retryable", code: undefined });
  });

  it("7. a TypeError from a failed fetch -> false", () => {
    const err = new TypeError("fetch failed");
    expect(classifyMetaSendError(err).retryable).toBe(false);
  });

  it("8. a bare string '131056' -> false", () => {
    expect(classifyMetaSendError("131056").retryable).toBe(false);
  });

  it("9. null / undefined -> false", () => {
    expect(classifyMetaSendError(null)).toEqual({ retryable: false, reason: "not_retryable", code: undefined });
    expect(classifyMetaSendError(undefined)).toEqual({ retryable: false, reason: "not_retryable", code: undefined });
  });

  it("10. 'sent to Meta but DB insert failed' (post-send persistence error) -> false — Meta already received the message", () => {
    const err = new Error("sent to Meta but DB insert failed: unique constraint violated");
    expect(classifyMetaSendError(err)).toEqual({ retryable: false, reason: "not_retryable", code: undefined });
  });

  it("never uses a MetaApiError whose code is merely a number that LOOKS like 131056 in some other field", () => {
    // errorSubcode carrying 131056 (not `code`) must NOT trigger retry —
    // only `code` is the source of truth.
    const err = metaError({ code: 4, errorSubcode: 131056, httpStatus: 400 });
    expect(classifyMetaSendError(err).retryable).toBe(false);
  });
});
