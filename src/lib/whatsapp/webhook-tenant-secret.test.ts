import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encrypt } from "./encryption";
import {
  extractWebhookSecretCandidateIds,
  resolveWebhookSignatureSecrets,
} from "./webhook-tenant-secret";

// ---------------------------------------------------------------------------
// feat/per-account-meta-app-secret
//
// `extractWebhookSecretCandidateIds` reads an UNTRUSTED, not-yet-verified
// body — it must never throw regardless of shape, and it must never be used
// for anything but picking routing ids. `resolveWebhookSignatureSecrets` is
// the fail-closed/per-row-fallback policy: see the multi-tenant rules this
// file proves against the required test list.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  app_secret: string | null;
}

function makeSupabase(configs: Row[]): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "whatsapp_config") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select: () => ({
          in: (col: "phone_number_id" | "waba_id", values: string[]) =>
            Promise.resolve({
              data: configs.filter((c) => values.includes(c[col] as string)),
              error: null,
            }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function messageEntry(wabaId: string, phoneNumberId: string) {
  return {
    id: wabaId,
    changes: [
      {
        field: "messages",
        value: { metadata: { phone_number_id: phoneNumberId } },
      },
    ],
  };
}

function templateEntry(wabaId: string) {
  // Template-lifecycle events carry no `metadata` at all.
  return {
    id: wabaId,
    changes: [
      {
        field: "message_template_status_update",
        value: { message_template_id: "123", event: "APPROVED" },
      },
    ],
  };
}

describe("extractWebhookSecretCandidateIds", () => {
  it("extracts phone_number_id from metadata when present, and drops the entry's waba_id (precedence fix)", () => {
    // An entry that already names an exact phone_number_id must NOT
    // also contribute its waba_id — see the module doc comment on why
    // (a sibling config on the same WABA must never be pulled in).
    const body = { entry: [messageEntry("waba-1", "pn-1")] };
    expect(extractWebhookSecretCandidateIds(body)).toEqual({
      phoneNumberIds: ["pn-1"],
      wabaIds: [],
    });
  });

  it("extracts entry.id ONLY when there is no phone_number_id anywhere in the entry (template events)", () => {
    const body = { entry: [templateEntry("waba-1")] };
    expect(extractWebhookSecretCandidateIds(body)).toEqual({
      phoneNumberIds: [],
      wabaIds: ["waba-1"],
    });
  });

  it("dedupes phone_number_id across multiple entries/changes, still without any waba_id", () => {
    const body = {
      entry: [
        messageEntry("waba-1", "pn-1"),
        messageEntry("waba-1", "pn-1"),
        messageEntry("waba-1", "pn-2"),
      ],
    };
    expect(extractWebhookSecretCandidateIds(body)).toEqual({
      phoneNumberIds: ["pn-1", "pn-2"],
      wabaIds: [],
    });
  });

  it("never throws on malformed/adversarial shapes", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      {},
      { entry: null },
      { entry: "not-an-array" },
      { entry: [null, 42, "x"] },
      { entry: [{ id: 123, changes: "nope" }] },
      { entry: [{ id: "waba-1", changes: [{ value: null }] }] },
      { entry: [{ id: "waba-1", changes: [{ value: { metadata: null } }] }] },
    ];
    for (const input of inputs) {
      expect(() => extractWebhookSecretCandidateIds(input)).not.toThrow();
    }
    expect(extractWebhookSecretCandidateIds(null)).toEqual({
      phoneNumberIds: [],
      wabaIds: [],
    });
  });

  it("a mixed payload still resolves waba_id for the entry that genuinely lacks a phone_number_id", () => {
    // Two separate entries under the same WABA: one message event (has
    // phone_number_id), one template event (doesn't). The template
    // entry's waba_id is a legitimate candidate; the message entry's
    // is not.
    const body = {
      entry: [messageEntry("waba-1", "pn-1"), templateEntry("waba-1")],
    };
    expect(extractWebhookSecretCandidateIds(body)).toEqual({
      phoneNumberIds: ["pn-1"],
      wabaIds: ["waba-1"],
    });
  });
});

describe("resolveWebhookSignatureSecrets — fail-closed + per-row fallback rules", () => {
  it("returns the decrypted app_secret for a config that has one (spec: tenant A + secret A)", async () => {
    const secretA = encrypt("secret-a-plaintext");
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: secretA },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toEqual(["secret-a-plaintext"]);
  });

  it("falls back to META_APP_SECRET only for a matched row with no app_secret of its own", async () => {
    const supabase = makeSupabase([
      { id: "cfg-legacy", account_id: "acct-legacy", phone_number_id: "pn-legacy", waba_id: "waba-legacy", app_secret: null },
    ]);
    const body = { entry: [messageEntry("waba-legacy", "pn-legacy")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toEqual([process.env.META_APP_SECRET]);
  });

  it("never returns the global secret for a row that already has its own app_secret", async () => {
    const secretA = encrypt("secret-a-plaintext");
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: secretA },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).not.toContain(process.env.META_APP_SECRET);
  });

  it("returns an empty array (fail closed) when no config matches at all", async () => {
    const supabase = makeSupabase([]);
    const body = { entry: [messageEntry("waba-unknown", "pn-unknown")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual([]);
  });

  it("returns an empty array when the body has no extractable ids — never queries at all", async () => {
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: encrypt("x") },
    ]);
    expect(await resolveWebhookSignatureSecrets(supabase, {})).toEqual([]);
  });

  it("resolves via phone_number_id for a standard message/status event", async () => {
    const secret = encrypt("pn-secret");
    const supabase = makeSupabase([
      { id: "cfg-1", account_id: "acct-1", phone_number_id: "pn-1", waba_id: "waba-1", app_secret: secret },
    ]);
    const body = { entry: [messageEntry("waba-other", "pn-1")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["pn-secret"]);
  });

  it("resolves via entry.id (waba_id) when there is no phone_number_id (template events)", async () => {
    const secret = encrypt("waba-secret");
    const supabase = makeSupabase([
      { id: "cfg-1", account_id: "acct-1", phone_number_id: "pn-1", waba_id: "waba-1", app_secret: secret },
    ]);
    const body = { entry: [templateEntry("waba-1")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["waba-secret"]);
  });

  it("dedupes candidate secrets across multiple configs on the same WABA", async () => {
    const shared = encrypt("shared-secret");
    const supabase = makeSupabase([
      { id: "cfg-1", account_id: "acct-1", phone_number_id: "pn-1", waba_id: "waba-1", app_secret: shared },
      { id: "cfg-2", account_id: "acct-1", phone_number_id: "pn-2", waba_id: "waba-1", app_secret: shared },
    ]);
    const body = { entry: [templateEntry("waba-1")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["shared-secret"]);
  });

  it("returns multiple distinct candidates when configs on the same WABA carry different secrets", async () => {
    const supabase = makeSupabase([
      { id: "cfg-1", account_id: "acct-1", phone_number_id: "pn-1", waba_id: "waba-1", app_secret: encrypt("secret-1") },
      { id: "cfg-2", account_id: "acct-2", phone_number_id: "pn-2", waba_id: "waba-1", app_secret: encrypt("secret-2") },
    ]);
    const body = { entry: [templateEntry("waba-1")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets.sort()).toEqual(["secret-1", "secret-2"]);
  });

  it("skips a row whose app_secret fails to decrypt, without throwing, and still returns other candidates", async () => {
    const supabase = makeSupabase([
      { id: "cfg-bad", account_id: "acct-bad", phone_number_id: "pn-bad", waba_id: "waba-1", app_secret: "not-valid-ciphertext" },
      { id: "cfg-good", account_id: "acct-good", phone_number_id: "pn-good", waba_id: "waba-1", app_secret: encrypt("good-secret") },
    ]);
    const body = { entry: [templateEntry("waba-1")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toEqual(["good-secret"]);
  });

  it("does not leak a tenant's config to another phone_number_id claiming its waba (still scoped to matched rows only)", async () => {
    // Two accounts, two WABAs, two phone numbers — a payload for pn-b
    // must never resolve acct-a's secret.
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: encrypt("secret-a") },
      { id: "cfg-b", account_id: "acct-b", phone_number_id: "pn-b", waba_id: "waba-b", app_secret: encrypt("secret-b") },
    ]);
    const body = { entry: [messageEntry("waba-b", "pn-b")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["secret-b"]);
  });
});

// ---------------------------------------------------------------------------
// Security fix: phone_number_id precedence over waba_id, same WABA.
//
// WABA X has two numbers: A (its own app_secret) and B (legacy, no
// app_secret — falls back to META_APP_SECRET). A webhook whose payload
// names phone_number_id=A must resolve ONLY A's own secret as a
// candidate — B's fallback must never be introduced just because B
// shares the WABA. Before the fix, `resolveWebhookSignatureSecrets`
// queried by waba_id UNCONDITIONALLY (in addition to phone_number_id),
// which pulled B's row in and let META_APP_SECRET verify a request
// that named A's exact number.
// ---------------------------------------------------------------------------
describe("resolveWebhookSignatureSecrets — phone_number_id precedence over a sibling's waba_id fallback", () => {
  function sameWabaConfigs() {
    return [
      {
        id: "cfg-a",
        account_id: "acct-a",
        phone_number_id: "pn-a",
        waba_id: "waba-x",
        app_secret: encrypt("secret-a"),
      },
      {
        id: "cfg-b",
        account_id: "acct-b",
        phone_number_id: "pn-b",
        waba_id: "waba-x",
        app_secret: null, // legacy — no secret of its own
      },
    ];
  }

  it("1. a payload for number A does NOT resolve number B's META_APP_SECRET fallback as a candidate", async () => {
    const supabase = makeSupabase(sameWabaConfigs());
    const body = { entry: [messageEntry("waba-x", "pn-a")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toEqual(["secret-a"]);
    expect(secrets).not.toContain(process.env.META_APP_SECRET);
  });

  it("1b. consequently, a payload for number A signed with the global META_APP_SECRET does not verify (would need the route's 401)", async () => {
    const supabase = makeSupabase(sameWabaConfigs());
    const body = { entry: [messageEntry("waba-x", "pn-a")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    // The route tries verifyMetaWebhookSignature against every returned
    // candidate; META_APP_SECRET is not among them, so signing with it
    // can never match. (End-to-end 401 coverage lives in
    // route.signature.test.ts.)
    expect(secrets).toEqual(["secret-a"]);
  });

  it("2. the same payload, correctly signed with A's own app_secret, verifies", async () => {
    const supabase = makeSupabase(sameWabaConfigs());
    const body = { entry: [messageEntry("waba-x", "pn-a")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toContain("secret-a");
  });

  it("3. an event with no phone_number_id (entry.id=WABA only) still resolves via the WABA, including B's fallback", async () => {
    const supabase = makeSupabase(sameWabaConfigs());
    const body = { entry: [templateEntry("waba-x")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    // No phone_number_id anywhere in this entry, so waba_id resolution
    // is the correct — and only available — path. Both A's specific
    // secret and B's global fallback are legitimate candidates here.
    expect(secrets.sort()).toEqual([process.env.META_APP_SECRET, "secret-a"].sort());
  });
});

// ---------------------------------------------------------------------------
// Security fix: cross-entry INTERSECTION, not a global union.
//
// A single HTTP delivery can batch several `entry` objects, each its own
// routing unit. Accepting the request whenever ANY unit's secret matched
// (the old behavior) would let a body signed with tenant A's secret smuggle
// in an entry that actually names tenant B — A's valid signature over the
// whole raw body says nothing about B's entry being legitimate. Only a
// secret valid for EVERY unit in the payload may be used to verify it.
// ---------------------------------------------------------------------------
describe("resolveWebhookSignatureSecrets — cross-entry intersection", () => {
  it("1. entry A (secret A) + entry B (secret B), no secret in common -> empty result (401 at the route)", async () => {
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: encrypt("secret-a") },
      { id: "cfg-b", account_id: "acct-b", phone_number_id: "pn-b", waba_id: "waba-b", app_secret: encrypt("secret-b") },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a"), messageEntry("waba-b", "pn-b")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual([]);
  });

  it("2. entry A and entry B both use the SAME app_secret X -> X is the (only) resolved candidate", async () => {
    const shared = encrypt("secret-x");
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: shared },
      { id: "cfg-b", account_id: "acct-b", phone_number_id: "pn-b", waba_id: "waba-b", app_secret: shared },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a"), messageEntry("waba-b", "pn-b")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["secret-x"]);
  });

  it("3. entry A (own secret A) + entry B (legacy, META_APP_SECRET) -> no secret in common -> empty result", async () => {
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: encrypt("secret-a") },
      { id: "cfg-b", account_id: "acct-b", phone_number_id: "pn-b", waba_id: "waba-b", app_secret: null },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a"), messageEntry("waba-b", "pn-b")] };
    const secrets = await resolveWebhookSignatureSecrets(supabase, body);
    expect(secrets).toEqual([]);
    // Confirms this isn't accidentally passing because secret-a happens
    // to equal META_APP_SECRET.
    expect("secret-a").not.toBe(process.env.META_APP_SECRET);
  });

  it("4. entry message for number A ({A}) + entry template on the SAME WABA ({A, B}) -> intersection is {A}", async () => {
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-x", app_secret: encrypt("secret-a") },
      { id: "cfg-b", account_id: "acct-b", phone_number_id: "pn-b", waba_id: "waba-x", app_secret: null },
    ]);
    const body = { entry: [messageEntry("waba-x", "pn-a"), templateEntry("waba-x")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["secret-a"]);
  });

  it("5. single-entry payloads are unaffected — a lone unit's own set IS the intersection", async () => {
    const supabase = makeSupabase([
      { id: "cfg-a", account_id: "acct-a", phone_number_id: "pn-a", waba_id: "waba-a", app_secret: encrypt("secret-a") },
    ]);
    const body = { entry: [messageEntry("waba-a", "pn-a")] };
    expect(await resolveWebhookSignatureSecrets(supabase, body)).toEqual(["secret-a"]);
  });
});
