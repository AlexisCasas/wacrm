import { describe, expect, it } from "vitest";
import { MIN_CRON_SECRET_LENGTH, authenticateCron } from "./cron-auth";

const SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const req = (headers: Record<string, string> = {}, url = "http://x/y") => new Request(url, { headers });

describe("authenticateCron", () => {
  it("accepts only the exact header secret", () => {
    expect(authenticateCron(req({ "x-cron-secret": SECRET }), SECRET)).toEqual({ ok: true });
    for (const bad of ["", "x", SECRET.toUpperCase(), SECRET + "0", SECRET.slice(1)]) expect(authenticateCron(req({ "x-cron-secret": bad }), SECRET)).toEqual({ ok: false, status: 401, error: "Unauthorized" });
    expect(authenticateCron(req(), SECRET)).toMatchObject({ ok: false, status: 401 });
  });
  it("is not configured with a missing or short secret (a weak secret is refused, not accepted)", () => {
    expect(authenticateCron(req({ "x-cron-secret": "a" }), undefined)).toMatchObject({ ok: false, status: 503 });
    expect(authenticateCron(req({ "x-cron-secret": "a".repeat(MIN_CRON_SECRET_LENGTH - 1) }), "a".repeat(MIN_CRON_SECRET_LENGTH - 1))).toMatchObject({ ok: false, status: 503 });
    expect(authenticateCron(req({ "x-cron-secret": "a".repeat(MIN_CRON_SECRET_LENGTH) }), "a".repeat(MIN_CRON_SECRET_LENGTH))).toEqual({ ok: true });
  });
  it("refuses a secret in the query string before comparing anything", () => {
    for (const name of ["secret", "TOKEN", "key", "cron_secret", "apikey"]) expect(authenticateCron(req({ "x-cron-secret": SECRET }, `http://x/y?${name}=${SECRET}`), SECRET)).toEqual({ ok: false, status: 400, error: "secret_in_url_refused" });
    expect(authenticateCron(req({ "x-cron-secret": SECRET }, "http://x/y?limit=5"), SECRET)).toEqual({ ok: true });
  });
});
