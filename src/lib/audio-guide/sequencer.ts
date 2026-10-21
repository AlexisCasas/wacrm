/**
 * Sends the audios of one `audio_guide_requests` row, one at a time, in order, each after its pause.
 *
 * State lives in the database (migration 075), never in this process: every step is "claim the next due audio" (an atomic
 * pending -> sending that two workers can never both win), "send it", "record the outcome". So the Flow node and the resumer can run
 * the same request at the same time, a worker can die at any point, and nothing is sent twice or out of order.
 *
 * What this guarantees, and what it cannot:
 *   - AT MOST ONE ATTEMPT per audio. A send that was claimed and never recorded is, after a grace period, `uncertain` and is NEVER sent
 *     again automatically. A send Meta rejected is `failed` and is not retried here either.
 *   - Trouble stops the sequence: nothing is sent after a failed or uncertain audio, so the customer never gets audio 3 without audio 2.
 *   - EXACTLY-ONCE DELIVERY IS NOT GUARANTEED. If the process dies after Meta accepted a message and before the outcome was written, the
 *     audio is recorded `uncertain` although the customer has it; if it dies before Meta received it, also `uncertain` although they do
 *     not. The design refuses to guess in either direction.
 *   - A request is `completed` only when every audio is `sent`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { ContactBlockedError } from "@/lib/contacts/blocking";
import { buildVoiceNotePublicUrl } from "@/lib/media/voice-note-path";
import { MetaApiError } from "@/lib/whatsapp/meta-api";

export type SequencerDb = Pick<SupabaseClient, "from" | "rpc">;

/** Per-run time the inline caller (the Flow node, inside the webhook's 60 s) may spend: 6 audios x (5 s pause + Meta) fit with margin. */
export const INLINE_BUDGET_MS = 45_000;
/** A claimed send with no outcome after this long is uncertain (the process that claimed it is gone). */
export const STALE_SEND_SECONDS = 180;

export interface SendContext {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
}

export interface SequencerDeps {
  /** Sends ONE voice note through the existing transport (engineSendMedia with voice: true). Throws on any failure. */
  sendVoiceNote(args: SendContext & { link: string }): Promise<{ whatsappMessageId: string }>;
  /** Checked before every claim: a reason to stop (blocked contact, human took over, run no longer active) or null. */
  haltReason?(): Promise<string | null>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Storage origin for the public URLs; defaults to NEXT_PUBLIC_SUPABASE_URL. */
  origin?: string;
}

export type SequenceOutcome =
  | { kind: "completed"; sent: number }
  | { kind: "incomplete"; sent: number; requestStatus: string; reason: string }
  | { kind: "halted"; sent: number; reason: string; requestStatus: string }
  | { kind: "busy"; sent: number }
  | { kind: "deferred"; sent: number };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What reached the log: no tokens, no query strings, no control characters, bounded. */
export function sanitizeError(message: unknown): string {
  const text = typeof message === "string" ? message : message instanceof Error ? message.message : "error";
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(access_token|token|secret|authorization|api[_-]?key)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/gi, "$1?[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 400);
}

export interface SendFailure {
  status: "failed" | "uncertain";
  code: string;
}

/**
 * Whether Meta may have the message. `failed` only when it is certain the provider did NOT accept it (it answered with an error, or the
 * call was never made); `uncertain` whenever Meta might have it, and for anything unrecognised.
 */
export function classifySendError(err: unknown): SendFailure {
  if (err instanceof ContactBlockedError) return { status: "failed", code: "contact_blocked" };
  if (err instanceof MetaApiError || (err instanceof Error && err.name === "MetaApiError")) {
    const e = err as MetaApiError;
    return { status: "failed", code: `meta_${e.code ?? e.httpStatus ?? "error"}`.slice(0, 80) };
  }
  const message = err instanceof Error ? err.message : String(err);
  // The provider accepted it, our own Inbox write failed afterwards: the customer has it.
  if (message.startsWith("sent to Meta but DB insert failed") || message.startsWith("sent via ManyChat bridge but DB insert failed")) {
    return { status: "uncertain", code: "accepted_not_recorded" };
  }
  // Refusals raised before any provider call (not enabled, invalid link, ManyChat transport, unknown contact, no WhatsApp config).
  if (/^\[flows\]/.test(message) || /^(contact not found|contact phone invalid|WhatsApp not configured)/.test(message)) {
    return { status: "failed", code: "not_attempted" };
  }
  return { status: "uncertain", code: "ambiguous_error" };
}

async function rpc<T extends Record<string, unknown>>(db: SequencerDb, fn: string, args: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await db.rpc(fn, args);
  if (error || !data || typeof data !== "object") return null;
  return data as T;
}

/** Writing the outcome is retried briefly: Meta already has the message, so the record is worth a few attempts. */
async function recordOutcome(db: SequencerDb, deps: Required<Pick<SequencerDeps, "sleep">>, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await rpc<Record<string, unknown>>(db, "audio_guide_finish_send", args);
    if (result?.ok === true) return result;
    if (result && result.ok === false && result.reason !== undefined) return result; // a definite refusal, not a transient failure
    await deps.sleep(200 * (attempt + 1));
  }
  return null;
}

export async function runAudioSequence(args: {
  db: SequencerDb;
  context: SendContext;
  requestId: string;
  deps: SequencerDeps;
  budgetMs?: number;
  staleSeconds?: number;
}): Promise<SequenceOutcome> {
  const { db, context, requestId, deps } = args;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const staleSeconds = args.staleSeconds ?? STALE_SEND_SECONDS;
  const deadline = now() + (args.budgetMs ?? INLINE_BUDGET_MS);
  const origin = deps.origin ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!origin) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  let sent = 0;

  for (let guard = 0; guard < 64; guard++) {
    const reason = deps.haltReason ? await deps.haltReason() : null;
    if (reason) {
      const halted = await rpc<{ ok?: boolean; status?: string }>(db, "audio_guide_halt_request", { p_account: context.accountId, p_request: requestId, p_reason: reason });
      return { kind: "halted", sent, reason, requestStatus: String(halted?.status ?? "unknown") };
    }

    const claim = await rpc<{ state?: string; status?: string; wait_ms?: number; send?: { id: string; sha256: string; position: number } }>(
      db, "audio_guide_claim_next_send", { p_account: context.accountId, p_request: requestId, p_stale_seconds: staleSeconds });
    if (!claim) return { kind: "incomplete", sent, requestStatus: "unknown", reason: "claim_failed" };

    if (claim.state === "finished") {
      return claim.status === "completed" ? { kind: "completed", sent } : { kind: "incomplete", sent, requestStatus: String(claim.status), reason: "sequence_halted" };
    }
    if (claim.state === "busy") return { kind: "busy", sent };
    if (claim.state === "wait") {
      const wait = Number(claim.wait_ms ?? 0);
      if (now() + wait > deadline) return { kind: "deferred", sent }; // not enough budget: leave it for the resumer, do not hold the webhook
      await sleep(wait + 50);
      continue;
    }
    if (claim.state !== "claimed" || !claim.send) return { kind: "incomplete", sent, requestStatus: "unknown", reason: `unexpected_claim_${claim.state ?? "none"}` };

    const link = buildVoiceNotePublicUrl(origin, context.accountId, claim.send.sha256);
    let outcome: Record<string, unknown> | null;
    try {
      const result = await deps.sendVoiceNote({ ...context, link });
      outcome = await recordOutcome(db, { sleep }, { p_account: context.accountId, p_send: claim.send.id, p_status: "sent", p_wamid: result.whatsappMessageId });
      if (!outcome || outcome.ok !== true) {
        // Meta accepted it, and the database would not say so. The send stays `sending`; once the grace period passes it is recorded as
        // uncertain. Stop here: nothing may be sent after an audio whose state is unknown.
        console.error("[audio-guide] sent to Meta but could not record the outcome (send stays in flight, will become uncertain)");
        return { kind: "incomplete", sent: sent + 1, requestStatus: "sending", reason: "outcome_not_recorded" };
      }
      sent += 1;
    } catch (err) {
      const failure = classifySendError(err);
      outcome = await recordOutcome(db, { sleep }, { p_account: context.accountId, p_send: claim.send.id, p_status: failure.status, p_error_code: failure.code, p_error_detail: sanitizeError(err) });
      return { kind: "incomplete", sent, requestStatus: String(outcome?.request_status ?? "sending"), reason: failure.code };
    }
  }
  return { kind: "incomplete", sent, requestStatus: "sending", reason: "step_limit" };
}

// ----------------------------------------------------------------------------------------------------------------- halt checks
/** Why a sequence must stop before the next audio, or null. Fails CLOSED: if it cannot tell, it stops. */
export function makeHaltCheck(args: {
  db: SequencerDb; accountId: string; contactId: string; conversationId: string; runId?: string | null; requestCreatedAtIso: string;
  /**
   * What the originating run's status means. `active` (the Flow node, still running): any other status stops the sequence. `not_taken_over`
   * (the resumer, long after the node returned and its run ended on purpose): only a run an agent took over (`paused_by_agent`) stops it.
   */
  runRule?: "active" | "not_taken_over";
}): () => Promise<string | null> {
  const { db, accountId, contactId, conversationId, runId, requestCreatedAtIso } = args;
  const runRule = args.runRule ?? "active";
  return async () => {
    const { data: contact, error } = await db.from("contacts").select("blocked").eq("id", contactId).eq("account_id", accountId).maybeSingle();
    if (error || !contact) return "halt_check_failed";
    if ((contact as { blocked?: boolean }).blocked) return "contact_blocked";
    if (runId) {
      const { data: run, error: runError } = await db.from("flow_runs").select("status").eq("id", runId).eq("account_id", accountId).maybeSingle();
      if (runError || !run) return "halt_check_failed";
      const runStatus = (run as { status?: string }).status;
      if (runRule === "active" ? runStatus !== "active" : runStatus === "paused_by_agent") return "run_not_active";
    }
    // An agent wrote in this conversation after the request was opened: a person took over.
    const { data: agent, error: agentError } = await db.from("messages").select("id").eq("conversation_id", conversationId).eq("sender_type", "agent").gte("created_at", requestCreatedAtIso).limit(1);
    if (agentError) return "halt_check_failed";
    if ((agent as unknown[] | null)?.length) return "human_takeover";
    return null;
  };
}

// ----------------------------------------------------------------------------------------------------------------- the resumer
/**
 * What the original Flow run's timeline says when a request is closed by the resumer, AFTER the run itself ended. The run's own status is
 * never touched (a run that failed with `audio_sequence_incomplete` stays failed: its logical path did not complete, and the steps after
 * the node did not run). The timeline only gains a line saying what became of the audios, so an operator reading the run is not misled.
 */
async function noteRecoveryOnRun(db: SequencerDb, accountId: string, runId: string | null, requestId: string, outcome: SequenceOutcome): Promise<void> {
  if (!runId) return;
  let event: { event_type: "message_sent" | "error"; reason: string; extra: Record<string, unknown> } | null = null;
  if (outcome.kind === "completed" && outcome.sent > 0) event = { event_type: "message_sent", reason: "audio_sequence_recovered", extra: { sent_in_recovery: outcome.sent, request_status: "completed" } };
  else if (outcome.kind === "halted") event = { event_type: "error", reason: "audio_sequence_closed", extra: { sent_in_recovery: outcome.sent, request_status: outcome.requestStatus, why: outcome.reason } };
  else if (outcome.kind === "incomplete" && ["partial", "failed"].includes(outcome.requestStatus)) event = { event_type: "error", reason: "audio_sequence_closed", extra: { sent_in_recovery: outcome.sent, request_status: outcome.requestStatus, why: outcome.reason } };
  if (!event) return;
  // The run must belong to this account; the insert is best effort (the request row is the source of truth).
  const { data: run } = await db.from("flow_runs").select("id").eq("id", runId).eq("account_id", accountId).maybeSingle();
  if (!run) return;
  await db.from("flow_run_events").insert({ flow_run_id: runId, event_type: event.event_type, node_key: null, payload: { node_type: "send_product_audios", phase: "recovery", request_id: requestId, reason: event.reason, ...event.extra } });
}

export interface ResumeSummary { examined: number; completed: number; incomplete: number; halted: number; busy: number; deferred: number; skippedDisabled: number; errors: number }

/**
 * Picks up requests whose next audio is due (or whose in-flight audio is stale) and runs them. Not scheduled anywhere: something has to
 * call it (see /api/audio-guide/cron). Safe to run concurrently with the Flow node and with itself.
 */
export async function resumeAudioRequests(args: {
  db: SequencerDb;
  limit?: number;
  budgetMs?: number;
  isEnabled: (accountId: string) => boolean;
  depsFor: (context: SendContext) => SequencerDeps;
  now?: () => number;
}): Promise<ResumeSummary> {
  const { db } = args;
  const now = args.now ?? Date.now;
  const deadline = now() + (args.budgetMs ?? 50_000);
  const summary: ResumeSummary = { examined: 0, completed: 0, incomplete: 0, halted: 0, busy: 0, deferred: 0, skippedDisabled: 0, errors: 0 };
  const { data, error } = await db.rpc("audio_guide_recoverable_requests", { p_limit: args.limit ?? 20, p_stale_seconds: STALE_SEND_SECONDS });
  if (error) throw new Error("could not list recoverable audio requests");
  for (const row of (data as Array<{ account_id: string; request_id: string }> | null) ?? []) {
    if (now() >= deadline) break;
    summary.examined++;
    if (!args.isEnabled(row.account_id)) { summary.skippedDisabled++; continue; }
    try {
      const { data: request } = await db.from("audio_guide_requests").select("id, contact_id, conversation_id, flow_run_id, created_at").eq("id", row.request_id).eq("account_id", row.account_id).maybeSingle();
      const r = request as { contact_id: string | null; conversation_id: string | null; flow_run_id: string | null; created_at: string } | null;
      if (!r?.contact_id || !r.conversation_id) { summary.errors++; continue; }
      const { data: conversation } = await db.from("conversations").select("user_id").eq("id", r.conversation_id).eq("account_id", row.account_id).maybeSingle();
      const userId = (conversation as { user_id?: string } | null)?.user_id;
      if (!userId) { summary.errors++; continue; }
      const context: SendContext = { accountId: row.account_id, userId, conversationId: r.conversation_id, contactId: r.contact_id };
      const base = args.depsFor(context);
      const deps: SequencerDeps = {
        ...base,
        haltReason: makeHaltCheck({ db, accountId: row.account_id, contactId: r.contact_id, conversationId: r.conversation_id, runId: r.flow_run_id, requestCreatedAtIso: r.created_at, runRule: "not_taken_over" }),
      };
      const outcome = await runAudioSequence({ db, context, requestId: row.request_id, deps, budgetMs: Math.max(1_000, deadline - now()) });
      await noteRecoveryOnRun(db, row.account_id, r.flow_run_id, row.request_id, outcome).catch((e) => console.error("[audio-guide] could not note the recovery on the run:", sanitizeError(e)));
      summary[outcome.kind === "completed" ? "completed" : outcome.kind === "halted" ? "halted" : outcome.kind === "busy" ? "busy" : outcome.kind === "deferred" ? "deferred" : "incomplete"]++;
    } catch (err) {
      summary.errors++;
      console.error("[audio-guide] resume failed:", sanitizeError(err));
    }
  }
  return summary;
}
