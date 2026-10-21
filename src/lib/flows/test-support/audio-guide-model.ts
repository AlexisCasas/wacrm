/**
 * A JavaScript model of the audio-guide sequencer functions of migration 075, over the in-memory database. It exists so the node, the
 * runner and the sequencer can be tested quickly and deterministically with a fake clock. It MIRRORS the SQL (qa/audio-guide/db-sequencer.sql
 * proves the real thing, and qa runs the same scenarios against a real PostgreSQL); it is not a substitute for it.
 */
import type { MemoryDbOptions, Row } from "./memory-db";

export interface Clock { now(): number; advance(ms: number): void }
export const createClock = (start = Date.UTC(2026, 9, 18, 12, 0, 0)): Clock => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

type Tables = (name: string) => Row[];
const ok = (data: Record<string, unknown>) => ({ data });

export function audioGuideRpc(table: Tables, clock: Clock): NonNullable<MemoryDbOptions["rpc"]> {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const iso = () => new Date(clock.now()).toISOString();
  const requests = () => table("audio_guide_requests");
  const sends = () => table("audio_guide_sends");
  const sendsOf = (requestId: unknown) => sends().filter((s) => s.request_id === requestId).sort((a, b) => Number(a.position) - Number(b.position));

  const refresh = (requestId: unknown): string => {
    const all = sendsOf(requestId), n = (st: string) => all.filter((s) => s.status === st).length;
    const sent = n("sent");
    const status = all.length && sent === all.length ? "completed" : n("pending") + n("sending") > 0 ? (sent > 0 || n("sending") > 0 ? "sending" : "claimed") : sent > 0 ? "partial" : "failed";
    const req = requests().find((r) => r.id === requestId)!;
    req.status = status;
    req.finished_at = ["completed", "partial", "failed"].includes(status) ? (req.finished_at ?? iso()) : null;
    return status;
  };

  return {
    audio_guide_open_request: (a) => {
      const existing = requests().find((r) => r.account_id === a.p_account && r.trigger_message_id === a.p_trigger);
      if (existing) return ok({ ok: true, created: false, request_id: existing.id, status: existing.status });
      const product = table("audio_guide_products").find((p) => p.account_id === a.p_account && p.product_key === a.p_product_key);
      if (!product || !product.active) return ok({ ok: false, reason: "product_unavailable" });
      if (a.p_expected_revision != null && product.revision !== a.p_expected_revision) return ok({ ok: false, reason: "catalog_changed" });
      const items = table("audio_guide_items").filter((i) => i.account_id === a.p_account && i.product_id === product.id && i.status === "active").sort((x, y) => Number(x.position) - Number(y.position));
      if (!items.length) return ok({ ok: false, reason: "no_audios" });
      const request: Row = { id: id("req"), account_id: a.p_account, contact_id: a.p_contact, conversation_id: a.p_conversation, flow_run_id: a.p_run, trigger_message_id: a.p_trigger, product_id: product.id, product_key: product.product_key, status: "claimed", reason: null, created_at: iso(), finished_at: null };
      requests().push(request);
      items.forEach((it, n) => sends().push({ id: id("send"), account_id: a.p_account, request_id: request.id, item_id: it.id, position: n + 1, voice_sha256: it.voice_sha256, status: "pending", whatsapp_message_id: null, error_code: null, error_detail: null, pre_delay_seconds: it.pre_delay_seconds, not_before: n === 0 ? clock.now() + Number(it.pre_delay_seconds) * 1000 : null, started_at: null, finished_at: null }));
      return ok({ ok: true, created: true, request_id: request.id, status: "claimed", sends: items.length });
    },
    audio_guide_record_skip: (a) => {
      if (requests().some((r) => r.account_id === a.p_account && r.trigger_message_id === a.p_trigger)) return ok({ ok: true, created: false });
      requests().push({ id: id("req"), account_id: a.p_account, contact_id: a.p_contact, conversation_id: a.p_conversation, flow_run_id: a.p_run, trigger_message_id: a.p_trigger, product_key: a.p_product_key, status: "skipped", reason: a.p_reason, created_at: iso(), finished_at: iso() });
      return ok({ ok: true, created: true });
    },
    audio_guide_halt_request: (a) => {
      const req = requests().find((r) => r.id === a.p_request && r.account_id === a.p_account);
      if (!req) return ok({ ok: false, reason: "not_found" });
      for (const s of sendsOf(req.id)) if (s.status === "sending" && Number(s.started_at) < clock.now() - 180_000) Object.assign(s, { status: "uncertain", error_code: "process_interrupted", finished_at: iso() });
      for (const s of sendsOf(req.id)) if (s.status === "pending") Object.assign(s, { status: "skipped", error_code: a.p_reason, finished_at: iso() });
      const status = refresh(req.id);
      req.reason ??= a.p_reason;
      return ok({ ok: true, status });
    },
    audio_guide_claim_next_send: (a) => {
      const req = requests().find((r) => r.id === a.p_request && r.account_id === a.p_account);
      if (!req) return ok({ state: "not_found" });
      if (["completed", "partial", "failed", "skipped"].includes(String(req.status))) return ok({ state: "finished", status: req.status });
      const all = sendsOf(req.id), stale = Number(a.p_stale_seconds ?? 180) * 1000;
      for (const s of all) if (s.status === "sending" && Number(s.started_at) < clock.now() - stale) Object.assign(s, { status: "uncertain", error_code: "process_interrupted", finished_at: iso() });
      if (all.some((s) => s.status === "sending")) return ok({ state: "busy" });
      if (all.some((s) => s.status === "failed" || s.status === "uncertain")) {
        for (const s of all) if (s.status === "pending") Object.assign(s, { status: "skipped", error_code: "sequence_halted", finished_at: iso() });
        return ok({ state: "finished", status: refresh(req.id) });
      }
      const next = all.find((s) => s.status === "pending");
      if (!next) return ok({ state: "finished", status: refresh(req.id) });
      if (next.not_before != null && Number(next.not_before) > clock.now()) return ok({ state: "wait", wait_ms: Number(next.not_before) - clock.now() });
      Object.assign(next, { status: "sending", started_at: clock.now() });
      refresh(req.id);
      return ok({ state: "claimed", send: { id: next.id, position: next.position, sha256: next.voice_sha256, item_id: next.item_id } });
    },
    audio_guide_finish_send: (a) => {
      if (!["sent", "failed", "uncertain"].includes(String(a.p_status))) return ok({ ok: false, reason: "invalid_status" });
      const send = sends().find((s) => s.id === a.p_send && s.account_id === a.p_account);
      if (!send) return ok({ ok: false, reason: "not_found" });
      if (send.status === a.p_status && a.p_status === "sent" && send.whatsapp_message_id === a.p_wamid) return ok({ ok: true, repeat: true });
      if (send.status !== "sending") return ok({ ok: false, reason: "not_sending", status: send.status });
      if (a.p_status === "sent" && !a.p_wamid) return ok({ ok: false, reason: "message_id_required" });
      Object.assign(send, { status: a.p_status, whatsapp_message_id: a.p_status === "sent" ? a.p_wamid : null, error_code: a.p_status === "sent" ? null : a.p_error_code, error_detail: a.p_status === "sent" ? null : a.p_error_detail, finished_at: iso() });
      if (a.p_status === "sent") {
        const following = sendsOf(send.request_id).find((s) => s.position === Number(send.position) + 1 && s.status === "pending");
        if (following) following.not_before = clock.now() + Number(following.pre_delay_seconds) * 1000;
      } else for (const s of sendsOf(send.request_id)) if (s.status === "pending") Object.assign(s, { status: "skipped", error_code: "sequence_halted", finished_at: iso() });
      return ok({ ok: true, request_status: refresh(send.request_id) });
    },
    audio_guide_recoverable_requests: (a) => {
      const stale = Number(a.p_stale_seconds ?? 180) * 1000;
      const rows = requests().filter((r) => ["claimed", "sending"].includes(String(r.status))).filter((r) => {
        const all = sendsOf(r.id), lowest = all.find((s) => s.status === "pending");
        const due = lowest && lowest.not_before != null && Number(lowest.not_before) <= clock.now() && !all.some((s) => s.status === "sending");
        return due || all.some((s) => s.status === "sending" && Number(s.started_at) < clock.now() - stale);
      }).slice(0, Number(a.p_limit ?? 20)).map((r) => ({ account_id: r.account_id, request_id: r.id }));
      return { data: rows };
    },
  };
}
