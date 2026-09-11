import { describe, expect, it } from "vitest";
import { MAX_META_RATE_LIMIT_RETRIES, metaRateLimitDelayMs } from "./meta-retry-backoff";

describe("metaRateLimitDelayMs", () => {
  it("retry 1 -> at least 60s", () => {
    expect(metaRateLimitDelayMs({ retryNumber: 1, seed: "s1" })).toBeGreaterThanOrEqual(60_000);
  });
  it("retry 2 -> at least 120s", () => {
    expect(metaRateLimitDelayMs({ retryNumber: 2, seed: "s2" })).toBeGreaterThanOrEqual(120_000);
  });
  it("retry 3 -> at least 300s", () => {
    expect(metaRateLimitDelayMs({ retryNumber: 3, seed: "s3" })).toBeGreaterThanOrEqual(300_000);
  });
  it("retry 4 -> at least 600s", () => {
    expect(metaRateLimitDelayMs({ retryNumber: 4, seed: "s4" })).toBeGreaterThanOrEqual(600_000);
  });
  it("retry 5 -> at least 900s", () => {
    expect(metaRateLimitDelayMs({ retryNumber: 5, seed: "s5" })).toBeGreaterThanOrEqual(900_000);
  });

  it("a Retry-After LARGER than our floor wins (retry #2 base=120s, provider=600s -> at least 600s)", () => {
    const delay = metaRateLimitDelayMs({ retryNumber: 2, retryAfterSeconds: 600, seed: "seed" });
    expect(delay).toBeGreaterThanOrEqual(600_000);
    expect(delay).toBeLessThan(600_000 + 5001);
  });

  it("a Retry-After SMALLER than our floor does NOT shorten it (retry #3 base=300s, provider=120s -> still at least 300s)", () => {
    const delay = metaRateLimitDelayMs({ retryNumber: 3, retryAfterSeconds: 120, seed: "seed" });
    expect(delay).toBeGreaterThanOrEqual(300_000);
    expect(delay).toBeLessThan(300_000 + 5001);
  });

  it("jitter is bounded to [0, 5000] ms on top of the base", () => {
    const delay = metaRateLimitDelayMs({ retryNumber: 1, seed: "any-seed" });
    const jitter = delay - 60_000;
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(5000);
  });

  it("the SAME seed always produces the SAME delay (deterministic, no Math.random)", () => {
    const a = metaRateLimitDelayMs({ retryNumber: 3, seed: "automation-1:contact-1:step-1:3" });
    const b = metaRateLimitDelayMs({ retryNumber: 3, seed: "automation-1:contact-1:step-1:3" });
    expect(a).toBe(b);
  });

  it("different seeds can (not must, but typically do) produce different jitter", () => {
    const a = metaRateLimitDelayMs({ retryNumber: 1, seed: "seed-a" });
    const b = metaRateLimitDelayMs({ retryNumber: 1, seed: "seed-b" });
    // Not a hard guarantee (a hash collision is possible), but with two
    // very different seeds a collision would be suspicious — assert
    // they're not BOTH exactly the base with zero jitter by coincidence.
    expect(a === 60_000 && b === 60_000).toBe(false);
  });

  it("no Retry-After -> pure base + jitter, never less than the base", () => {
    const delay = metaRateLimitDelayMs({ retryNumber: 4, seed: "no-provider" });
    expect(delay).toBeGreaterThanOrEqual(600_000);
    expect(delay).toBeLessThanOrEqual(600_000 + 5000);
  });

  it("retryNumber outside 1..5 fails fast (programming error, not a runtime condition to clamp)", () => {
    expect(() => metaRateLimitDelayMs({ retryNumber: 0, seed: "x" })).toThrow(/retryNumber/);
    expect(() => metaRateLimitDelayMs({ retryNumber: 6, seed: "x" })).toThrow(/retryNumber/);
    expect(() => metaRateLimitDelayMs({ retryNumber: -1, seed: "x" })).toThrow(/retryNumber/);
  });

  it("MAX_META_RATE_LIMIT_RETRIES is 5", () => {
    expect(MAX_META_RATE_LIMIT_RETRIES).toBe(5);
  });
});
