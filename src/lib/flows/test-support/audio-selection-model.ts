/**
 * A JavaScript model of the seven functions of migration 076 (purposes, identifiers, classification and the selective request), over the in-memory
 * database. Like audio-guide-model.ts it MIRRORS the SQL so the routes, the editor service and the Flow node can be tested quickly; the SQL itself is
 * proved against a real PostgreSQL by qa/audio-guide (db-selection.sql, the rehearsal on a copy and the production verification).
 *
 * To keep the model honest the tests check the CONTRACT with the real file: every call must use exactly the parameter names of the function in
 * supabase/migrations/076_audio_guide_selection.sql, and omit only parameters that have a DEFAULT (`checkSignatures`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryDbOptions, Row } from "./memory-db";
import type { Clock } from "./audio-guide-model";

type Tables = (name: string) => Row[];
const ok = (data: Record<string, unknown>) => ({ data });
const no = (reason: string, extra: Record<string, unknown> = {}) => ({ data: { ok: false, reason, ...extra } });

const MIGRATION = join(process.cwd(), "supabase/migrations/076_audio_guide_selection.sql");
const PRODUCT_FNS = ["audio_guide_save_purpose", "audio_guide_save_identifier", "audio_guide_delete_purpose", "audio_guide_delete_identifier", "audio_guide_classify_item", "audio_guide_open_selected_request", "audio_guide_record_selected_skip"] as const;

/** `{ function: { param: hasDefault } }` parsed from the real migration. */
export function migrationSignatures(): Record<string, Record<string, boolean>> {
  const sql = readFileSync(MIGRATION, "utf8");
  const out: Record<string, Record<string, boolean>> = {};
  for (const fn of PRODUCT_FNS) {
    const m = new RegExp(`CREATE FUNCTION public\\.${fn}\\(([\\s\\S]*?)\\)\\s*RETURNS`).exec(sql);
    if (!m) throw new Error(`function ${fn} not found in the migration`);
    out[fn] = {};
    for (const part of m[1].split(",")) {
      const p = /\b(p_[a-z_]+)\b\s+[A-Z\[\]]+(\s+DEFAULT\s+\S+)?/.exec(part.trim());
      if (p) out[fn][p[1]] = Boolean(p[2]);
    }
  }
  return out;
}

const SIGNATURES = migrationSignatures();

/** Throws unless `args` uses exactly the parameters of the real function (only those with a DEFAULT may be left out). */
export function checkSignature(fn: string, args: Row): void {
  const sig = SIGNATURES[fn];
  if (!sig) return;
  const given = new Set(Object.keys(args));
  for (const k of given) if (!(k in sig)) throw new Error(`${fn}: unknown argument ${k} (the migration has ${Object.keys(sig).join(", ")})`);
  for (const [k, hasDefault] of Object.entries(sig)) if (!given.has(k) && !hasDefault) throw new Error(`${fn}: missing required argument ${k}`);
}

export function audioSelectionRpc(table: Tables, clock: Clock): NonNullable<MemoryDbOptions["rpc"]> {
  let seq = 0;
  // UUID-shaped ids (the routes validate ids as UUIDs): the first hex digit tells the kind of row.
  const id = (p: "c" | "d" | "e" | "f") => `${p}0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const iso = () => new Date(clock.now()).toISOString();
  const products = () => table("audio_guide_products");
  const items = () => table("audio_guide_items");
  const requests = () => table("audio_guide_requests");
  const sends = () => table("audio_guide_sends");

  const validName = (name: string, key: string) =>
    name === name.trim() && name.length >= 1 && [...name].length <= 60 && key === key.toLowerCase().trim() && /^\S+( \S+)*$/.test(key) && [...key].length <= 60;

  function save(kind: "purpose" | "identifier", limit: number) {
    const t = () => table(kind === "purpose" ? "audio_guide_purposes" : "audio_guide_identifiers");
    return (a: Row) => {
      checkSignature(`audio_guide_save_${kind}`, a);
      if ((a.p_name == null) !== (a.p_name_key == null)) return no("invalid_value");
      if (a.p_id == null) {
        if (a.p_name == null) return no("invalid_value");
        if (t().filter((r) => r.account_id === a.p_account).length >= limit) return no("limit_reached");
        if (!validName(String(a.p_name), String(a.p_name_key))) return no("invalid_value");
        if (t().some((r) => r.account_id === a.p_account && r.name_key === a.p_name_key)) return no("duplicate_name");
        const row: Row = { id: id(kind === "purpose" ? "c" : "d"), account_id: a.p_account, name: a.p_name, name_key: a.p_name_key, active: a.p_active ?? true, created_at: iso(), updated_at: iso() };
        t().push(row);
        return ok({ ok: true, id: row.id });
      }
      const row = t().find((r) => r.id === a.p_id && r.account_id === a.p_account);
      if (!row) return no("not_found");
      const name = (a.p_name ?? row.name) as string, key = (a.p_name_key ?? row.name_key) as string;
      if (!validName(name, key)) return no("invalid_value");
      if (t().some((r) => r !== row && r.account_id === a.p_account && r.name_key === key)) return no("duplicate_name");
      Object.assign(row, { name, name_key: key, active: a.p_active ?? row.active, updated_at: iso() });
      return ok({ ok: true, id: row.id });
    };
  }

  function remove(kind: "purpose" | "identifier") {
    const t = () => table(kind === "purpose" ? "audio_guide_purposes" : "audio_guide_identifiers");
    const col = kind === "purpose" ? "purpose_id" : "identifier_id";
    return (a: Row) => {
      checkSignature(`audio_guide_delete_${kind}`, a);
      const row = t().find((r) => r.id === a.p_id && r.account_id === a.p_account);
      if (!row) return no("not_found");
      if (items().some((i) => i[col] === row.id)) return no("in_use"); // ON DELETE RESTRICT
      const mine = t(); mine.splice(mine.indexOf(row), 1);
      for (const r of requests()) if (r[col] === row.id) r[col] = null; // ON DELETE SET NULL (col)
      return ok({ ok: true });
    };
  }

  return {
    audio_guide_save_purpose: save("purpose", 50),
    audio_guide_save_identifier: save("identifier", 100),
    audio_guide_delete_purpose: remove("purpose"),
    audio_guide_delete_identifier: remove("identifier"),

    audio_guide_classify_item: (a) => {
      checkSignature("audio_guide_classify_item", a);
      const item = items().find((i) => i.id === a.p_item && i.account_id === a.p_account);
      if (!item) return no("not_found");
      const product = products().find((p) => p.id === item.product_id && p.account_id === a.p_account);
      if (!product) return no("not_found");
      if (a.p_expected == null || product.revision !== a.p_expected) return no("revision_conflict", { revision: product.revision });
      if ((a.p_purpose == null) !== (a.p_identifier == null)) return no("invalid_value");
      if (a.p_purpose != null && a.p_purpose !== item.purpose_id) {
        const p = table("audio_guide_purposes").find((r) => r.id === a.p_purpose && r.account_id === a.p_account);
        if (!p) return no("purpose_not_found");
        if (!p.active) return no("purpose_inactive");
      }
      if (a.p_identifier != null && a.p_identifier !== item.identifier_id) {
        const i = table("audio_guide_identifiers").find((r) => r.id === a.p_identifier && r.account_id === a.p_account);
        if (!i) return no("identifier_not_found");
        if (!i.active) return no("identifier_inactive");
      }
      const clash = a.p_purpose == null ? undefined : items().find((i) => i !== item && i.product_id === item.product_id && i.purpose_id === a.p_purpose && i.identifier_id === a.p_identifier);
      if (clash) return no("duplicate_classification", { conflict_item: clash.id }); // the unique index counts disabled audios too
      const changed = item.purpose_id !== (a.p_purpose ?? null) || item.identifier_id !== (a.p_identifier ?? null);
      Object.assign(item, { purpose_id: a.p_purpose ?? null, identifier_id: a.p_identifier ?? null });
      if (changed) product.revision = Number(product.revision) + 1; // the touch_product trigger
      return ok({ ok: true, revision: product.revision });
    },

    audio_guide_open_selected_request: (a) => {
      checkSignature("audio_guide_open_selected_request", a);
      const existing = requests().find((r) => r.account_id === a.p_account && r.trigger_message_id === a.p_trigger);
      if (existing) return ok({ ok: true, created: false, request_id: existing.id, status: existing.status });
      const product = products().find((p) => p.account_id === a.p_account && p.product_key === a.p_product_key);
      if (!product || !product.active) return no("product_unavailable");
      if (a.p_expected_revision != null && product.revision !== a.p_expected_revision) return no("catalog_changed");
      const purpose = table("audio_guide_purposes").find((r) => r.id === a.p_purpose && r.account_id === a.p_account);
      if (!purpose || !purpose.active) return no("purpose_unavailable");
      const identifier = table("audio_guide_identifiers").find((r) => r.id === a.p_identifier && r.account_id === a.p_account);
      if (!identifier || !identifier.active) return no("identifier_unavailable");
      const item = items().find((i) => i.account_id === a.p_account && i.product_id === product.id && i.purpose_id === a.p_purpose && i.identifier_id === a.p_identifier);
      if (!item) return no("audio_not_found");
      if (item.status !== "active") return no("audio_disabled");
      const request: Row = {
        id: id("e"), account_id: a.p_account, contact_id: a.p_contact, conversation_id: a.p_conversation, flow_run_id: a.p_run, trigger_message_id: a.p_trigger,
        product_id: product.id, product_key: product.product_key, status: "claimed", reason: null, created_at: iso(), finished_at: null,
        selection_mode: "single", purpose_id: purpose.id, identifier_id: identifier.id, purpose_name: purpose.name, identifier_name: identifier.name,
        node_key: a.p_node_key == null ? null : String(a.p_node_key).slice(0, 120),
      };
      requests().push(request);
      sends().push({ id: id("f"), account_id: a.p_account, request_id: request.id, item_id: item.id, position: 1, voice_sha256: item.voice_sha256, status: "pending", whatsapp_message_id: null, error_code: null, error_detail: null, pre_delay_seconds: item.pre_delay_seconds, not_before: clock.now() + Number(item.pre_delay_seconds) * 1000, started_at: null, finished_at: null });
      return ok({ ok: true, created: true, request_id: request.id, status: "claimed", sends: 1 });
    },

    audio_guide_record_selected_skip: (a) => {
      checkSignature("audio_guide_record_selected_skip", a);
      if (requests().some((r) => r.account_id === a.p_account && r.trigger_message_id === a.p_trigger)) return ok({ ok: true, created: false });
      const purpose = table("audio_guide_purposes").find((r) => r.id === a.p_purpose && r.account_id === a.p_account);
      const identifier = table("audio_guide_identifiers").find((r) => r.id === a.p_identifier && r.account_id === a.p_account);
      requests().push({
        id: id("e"), account_id: a.p_account, contact_id: a.p_contact, conversation_id: a.p_conversation, flow_run_id: a.p_run, trigger_message_id: a.p_trigger,
        product_key: a.p_product_key == null ? null : String(a.p_product_key).slice(0, 120), status: "skipped", reason: String(a.p_reason).slice(0, 200), created_at: iso(), finished_at: iso(),
        selection_mode: "single", purpose_id: purpose?.id ?? null, identifier_id: identifier?.id ?? null, purpose_name: purpose?.name ?? null, identifier_name: identifier?.name ?? null,
        node_key: a.p_node_key == null ? null : String(a.p_node_key).slice(0, 120),
      });
      return ok({ ok: true, created: true });
    },
  };
}
