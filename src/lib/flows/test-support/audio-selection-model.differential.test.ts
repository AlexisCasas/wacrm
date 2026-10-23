import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createMemoryDb, type Row } from "./memory-db";
import { createClock } from "./audio-guide-model";
import { audioSelectionRpc } from "./audio-selection-model";

// The JS model of migration 076 against the REAL SQL. This test runs a fixed scenario through the model and checks the outcomes the SQL must
// give; when DIFF_OUT is set it also writes the calls and the model's answers to that file, and
// ops/076-audio-selection/audio-guide/produccion-076/test-modelo-vs-sql-076.sh replays the very same calls on a throwaway PostgreSQL with
// migrations 001..076 and fails on the first answer that differs. So the fast tests of the routes and of the Flow node rest on a model that is
// checked against the database, not on the model's own opinion.

export const A = "a0000000-0000-4000-8000-0000000000a1", B = "b0000000-0000-4000-8000-0000000000b1";
export const PROD_A = "a1000000-0000-4000-8000-000000000001", PROD_A2 = "a1000000-0000-4000-8000-000000000002", PROD_B = "b1000000-0000-4000-8000-000000000001";
export const I1 = "a2000000-0000-4000-8000-000000000001", I2 = "a2000000-0000-4000-8000-000000000002", I3 = "a2000000-0000-4000-8000-000000000003", IB = "b2000000-0000-4000-8000-000000000001";
const sha = (c: string) => c.repeat(64);

export const seed = (): Record<string, Row[]> => ({
  audio_guide_products: [
    { id: PROD_A, account_id: A, product_key: "combo xtd", display_name: "Combo", active: true, revision: 3 },
    { id: PROD_A2, account_id: A, product_key: "otro", display_name: "Otro", active: true, revision: 3 },
    { id: PROD_B, account_id: B, product_key: "combo xtd", display_name: "Combo B", active: true, revision: 3 },
  ],
  audio_guide_items: [
    { id: I1, account_id: A, product_id: PROD_A, position: 1, voice_sha256: sha("1"), status: "active", pre_delay_seconds: 5, purpose_id: null, identifier_id: null },
    { id: I2, account_id: A, product_id: PROD_A, position: 2, voice_sha256: sha("2"), status: "disabled", pre_delay_seconds: 7, purpose_id: null, identifier_id: null },
    { id: I3, account_id: A, product_id: PROD_A2, position: 1, voice_sha256: sha("3"), status: "active", pre_delay_seconds: 9, purpose_id: null, identifier_id: null },
    { id: IB, account_id: B, product_id: PROD_B, position: 1, voice_sha256: sha("9"), status: "active", pre_delay_seconds: 5, purpose_id: null, identifier_id: null },
  ],
});

type Ref = { ref: string }; // an id returned by an earlier call (the real database generates its own)

/** The scenario. Arguments may reference ids returned earlier as { ref: "<label>.<field>" }. */
export const SCENARIO: Array<{ fn: string; label: string; args: Record<string, unknown | Ref> }> = [
  { fn: "audio_guide_save_purpose", label: "pay", args: { p_account: A, p_id: null, p_name: "Pago", p_name_key: "pago", p_active: true } },
  { fn: "audio_guide_save_purpose", label: "pay-dup", args: { p_account: A, p_id: null, p_name: "PAGO", p_name_key: "pago", p_active: true } },
  { fn: "audio_guide_save_purpose", label: "pay-space", args: { p_account: A, p_id: null, p_name: "Pago ", p_name_key: "pago", p_active: true } },
  { fn: "audio_guide_save_purpose", label: "pay-onlyname", args: { p_account: A, p_id: null, p_name: "Solo", p_name_key: null, p_active: true } },
  { fn: "audio_guide_save_purpose", label: "pay-b", args: { p_account: B, p_id: null, p_name: "Pago", p_name_key: "pago", p_active: true } },
  { fn: "audio_guide_save_purpose", label: "prov", args: { p_account: A, p_id: null, p_name: "Provincia", p_name_key: "provincia", p_active: true } },
  { fn: "audio_guide_save_identifier", label: "main", args: { p_account: A, p_id: null, p_name: "Principal", p_name_key: "principal", p_active: true } },
  { fn: "audio_guide_save_identifier", label: "alt", args: { p_account: A, p_id: null, p_name: "Alternativo", p_name_key: "alternativo", p_active: true } },
  { fn: "audio_guide_save_purpose", label: "rename-case", args: { p_account: A, p_id: { ref: "pay.id" }, p_name: "pago", p_name_key: "pago", p_active: null } },
  { fn: "audio_guide_save_purpose", label: "rename-clash", args: { p_account: A, p_id: { ref: "pay.id" }, p_name: "Provincia", p_name_key: "provincia", p_active: null } },
  { fn: "audio_guide_save_purpose", label: "foreign-update", args: { p_account: B, p_id: { ref: "pay.id" }, p_name: "X", p_name_key: "x", p_active: null } },
  { fn: "audio_guide_classify_item", label: "c1", args: { p_account: A, p_item: I1, p_expected: 3, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_classify_item", label: "c-dup", args: { p_account: A, p_item: I2, p_expected: 4, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_classify_item", label: "c-stale", args: { p_account: A, p_item: I2, p_expected: 3, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "alt.id" } } },
  { fn: "audio_guide_classify_item", label: "c-null-expected", args: { p_account: A, p_item: I2, p_expected: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "alt.id" } } },
  { fn: "audio_guide_classify_item", label: "c2-disabled", args: { p_account: A, p_item: I2, p_expected: 4, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "alt.id" } } },
  { fn: "audio_guide_classify_item", label: "c-half", args: { p_account: A, p_item: I3, p_expected: 3, p_purpose: { ref: "pay.id" }, p_identifier: null } },
  { fn: "audio_guide_classify_item", label: "c-foreign-purpose", args: { p_account: A, p_item: I3, p_expected: 3, p_purpose: { ref: "pay-b.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_classify_item", label: "c-unknown-item", args: { p_account: A, p_item: "ffffffff-ffff-4fff-8fff-ffffffffffff", p_expected: 3, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_classify_item", label: "c-other-product-same-pair", args: { p_account: A, p_item: I3, p_expected: 3, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_delete_purpose", label: "del-in-use", args: { p_account: A, p_id: { ref: "pay.id" } } },
  { fn: "audio_guide_open_selected_request", label: "open-ok", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.1#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-again", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.1#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-disabled", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.2#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "alt.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-notfound", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.3#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "prov.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-unknown-product", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.4#vp", p_product_key: "no existe", p_expected_revision: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-foreign-purpose", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.5#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "pay-b.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_open_selected_request", label: "open-stale", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.6#vp", p_product_key: "combo xtd", p_expected_revision: 1, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_save_purpose", label: "deactivate", args: { p_account: A, p_id: { ref: "pay.id" }, p_name: null, p_name_key: null, p_active: false } },
  { fn: "audio_guide_open_selected_request", label: "open-inactive", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.7#vp", p_product_key: "combo xtd", p_expected_revision: null, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_save_purpose", label: "promo-off", args: { p_account: A, p_id: null, p_name: "Promoción", p_name_key: "promocion", p_active: false } },
  { fn: "audio_guide_classify_item", label: "c-inactive-new", args: { p_account: A, p_item: I3, p_expected: 4, p_purpose: { ref: "promo-off.id" }, p_identifier: { ref: "main.id" } } },
  { fn: "audio_guide_classify_item", label: "c-keep-inactive", args: { p_account: A, p_item: I3, p_expected: 4, p_purpose: { ref: "pay.id" }, p_identifier: { ref: "alt.id" } } },
  { fn: "audio_guide_record_selected_skip", label: "skip", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.8#vp", p_product_key: "combo xtd", p_reason: "audio_not_found", p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_record_selected_skip", label: "skip-again", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.8#vp", p_product_key: "combo xtd", p_reason: "audio_not_found", p_purpose: { ref: "pay.id" }, p_identifier: { ref: "main.id" }, p_node_key: "vp" } },
  { fn: "audio_guide_record_selected_skip", label: "skip-foreign", args: { p_account: A, p_contact: null, p_conversation: null, p_run: null, p_trigger: "wamid.9#vp", p_product_key: null, p_reason: "gate_closed", p_purpose: { ref: "pay-b.id" }, p_identifier: null, p_node_key: "vp" } },
  { fn: "audio_guide_classify_item", label: "c-clear", args: { p_account: A, p_item: I1, p_expected: 5, p_purpose: null, p_identifier: null } },
  { fn: "audio_guide_delete_purpose", label: "del-ok", args: { p_account: B, p_id: { ref: "pay-b.id" } } },
  { fn: "audio_guide_delete_identifier", label: "del-id-unknown", args: { p_account: A, p_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
];

describe("the JS model of 076 against the scenario (the SQL replays the same one)", () => {
  it("gives the outcomes the SQL must give", async () => {
    const clock = createClock();
    const mem: ReturnType<typeof createMemoryDb> = createMemoryDb(seed(), { rpc: audioSelectionRpc((n) => mem.table(n), clock) });
    const refs: Record<string, unknown> = {};
    const recorded: Array<{ fn: string; label: string; args: Record<string, unknown>; result: Record<string, unknown> }> = [];
    for (const step of SCENARIO) {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(step.args)) args[k] = v && typeof v === "object" && "ref" in (v as object) ? refs[(v as Ref).ref] : v;
      const { data } = (await mem.client.rpc(step.fn, args)) as unknown as { data: Record<string, unknown> };
      for (const key of ["id", "request_id"]) if (typeof data[key] === "string") refs[`${step.label}.${key}`] = data[key];
      recorded.push({ fn: step.fn, label: step.label, args: step.args as Record<string, unknown>, result: data });
    }
    const by = Object.fromEntries(recorded.map((r) => [r.label, r.result]));
    expect(by.pay).toMatchObject({ ok: true });
    expect(by["pay-dup"]).toEqual({ ok: false, reason: "duplicate_name" });
    expect(by["pay-space"]).toEqual({ ok: false, reason: "invalid_value" });
    expect(by["pay-onlyname"]).toEqual({ ok: false, reason: "invalid_value" });
    expect(by["rename-case"]).toMatchObject({ ok: true });
    expect(by["rename-clash"]).toEqual({ ok: false, reason: "duplicate_name" });
    expect(by["foreign-update"]).toEqual({ ok: false, reason: "not_found" });
    expect(by.c1).toEqual({ ok: true, revision: 4 });
    expect(by["c-dup"]).toEqual({ ok: false, reason: "duplicate_classification", conflict_item: I1 });
    expect(by["c-stale"]).toEqual({ ok: false, reason: "revision_conflict", revision: 4 });
    expect(by["c-null-expected"]).toEqual({ ok: false, reason: "revision_conflict", revision: 4 });
    expect(by["c-half"]).toEqual({ ok: false, reason: "invalid_value" });
    expect(by["c-foreign-purpose"]).toEqual({ ok: false, reason: "purpose_not_found" });
    expect(by["del-in-use"]).toEqual({ ok: false, reason: "in_use" });
    expect(by["open-ok"]).toMatchObject({ ok: true, created: true, sends: 1 });
    expect(by["open-again"]).toMatchObject({ ok: true, created: false });
    expect(by["open-disabled"]).toEqual({ ok: false, reason: "audio_disabled" });
    expect(by["open-notfound"]).toEqual({ ok: false, reason: "audio_not_found" });
    expect(by["open-unknown-product"]).toEqual({ ok: false, reason: "product_unavailable" });
    expect(by["open-foreign-purpose"]).toEqual({ ok: false, reason: "purpose_unavailable" });
    expect(by["open-stale"]).toEqual({ ok: false, reason: "catalog_changed" });
    expect(by["open-inactive"]).toEqual({ ok: false, reason: "purpose_unavailable" });
    expect(by["promo-off"]).toMatchObject({ ok: true });
    expect(by["c-inactive-new"]).toEqual({ ok: false, reason: "purpose_inactive" });
    expect(by["c-keep-inactive"]).toEqual({ ok: true, revision: 5 }); // an audio keeps (and may re-pair) a purpose it already had, even if it is inactive now
    expect(by["c-other-product-same-pair"]).toEqual({ ok: true, revision: 4 });
    expect(by["c2-disabled"]).toEqual({ ok: true, revision: 5 });
    expect(by["c-clear"]).toEqual({ ok: true, revision: 6 });
    expect(by.skip).toEqual({ ok: true, created: true });
    expect(by["skip-again"]).toEqual({ ok: true, created: false });
    expect(by["skip-foreign"]).toEqual({ ok: true, created: true });
    expect(by["del-ok"]).toEqual({ ok: true });
    expect(by["del-id-unknown"]).toEqual({ ok: false, reason: "not_found" });
    if (process.env.DIFF_OUT) writeFileSync(process.env.DIFF_OUT, JSON.stringify({ seed: seed(), steps: recorded }, null, 1));
  });
});
