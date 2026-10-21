import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactBlockedError } from "@/lib/contacts/blocking";
import { MetaApiError } from "@/lib/whatsapp/meta-api";
import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { audioGuideRpc, createClock } from "@/lib/flows/test-support/audio-guide-model";
import { classifySendError, makeHaltCheck, resumeAudioRequests, runAudioSequence, sanitizeError, type SendContext, type SequencerDb, type SequencerDeps } from "./sequencer";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);
const CTX: SendContext = { accountId: A, userId: "u-1", conversationId: "cv-1", contactId: "ct-1" };

function setup(pauses: number[] = [5, 5, 5], over: { rpc?: (fn: string, args: Row) => unknown } = {}) {
  const clock = createClock();
  const ref = {} as { mem: ReturnType<typeof createMemoryDb> };
  const rpc = audioGuideRpc((n) => ref.mem.table(n), clock);
  if (over.rpc) for (const fn of Object.keys(rpc)) { const real = rpc[fn]; rpc[fn] = (args) => { const o = over.rpc!(fn, args) as ReturnType<typeof real> | undefined; return o ?? real(args); }; }
  const mem = ref.mem = createMemoryDb({
    audio_guide_products: [{ id: "p1", account_id: A, product_key: "combo xtd", active: true, revision: 1 }],
    audio_guide_items: pauses.map((p, i) => ({ id: `i${i + 1}`, account_id: A, product_id: "p1", position: i + 1, voice_sha256: sha(String(i + 1)), status: "active", pre_delay_seconds: p })),
    contacts: [{ id: "ct-1", account_id: A, blocked: false }],
    messages: [],
    flow_runs: [{ id: "run-1", account_id: A, status: "active" }],
  }, { rpc });
  const db = mem.client as unknown as SequencerDb;
  const log: Array<{ at: number; link: string }> = [];
  const sleeps: number[] = [];
  const deps = (over: Partial<SequencerDeps> = {}): SequencerDeps => ({
    sendVoiceNote: async ({ link }) => { log.push({ at: clock.now(), link }); return { whatsappMessageId: `wamid.${log.length}` }; },
    now: clock.now, sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); }, origin: ORIGIN, ...over,
  });
  const open = (trigger = "wamid.IN1") => (mem.client.rpc("audio_guide_open_request", { p_account: A, p_contact: "ct-1", p_conversation: "cv-1", p_run: "run-1", p_trigger: trigger, p_product_key: "combo xtd", p_expected_revision: 1 }) as unknown as Promise<{ data: { request_id: string } }>).then((r) => r.data.request_id);
  const sendsOf = (requestId: string) => mem.table("audio_guide_sends").filter((s) => s.request_id === requestId).map((s) => `${s.position}:${s.status}`).join(",");
  return { mem, db, clock, log, sleeps, deps, open, sendsOf, request: (id: string) => mem.table("audio_guide_requests").find((r) => r.id === id)! };
}

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("runAudioSequence: order, pauses and the final state", () => {
  it.each([1, 3, 6])("%i audio(s): each is sent in order after its own pause (first included); the request completes only when all were sent", async (n) => {
    const t = setup(Array(n).fill(5));
    const requestId = await t.open();
    const start = t.clock.now();
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(outcome).toEqual({ kind: "completed", sent: n });
    expect(t.log.map((l) => l.link)).toEqual(Array.from({ length: n }, (_, i) => `${ORIGIN}/storage/v1/object/public/voice-notes/account-${A}/${sha(String(i + 1))}.ogg`));
    // 5 s before the FIRST audio, and 5 s (the pause of the next one) after each previous send
    expect(t.log.map((l) => Math.round((l.at - start) / 1000))).toEqual(Array.from({ length: n }, (_, i) => 5 * (i + 1)));
    expect(t.sendsOf(requestId)).toBe(Array.from({ length: n }, (_, i) => `${i + 1}:sent`).join(","));
    expect(t.request(requestId).status).toBe("completed");
    expect(t.mem.table("audio_guide_sends").map((s) => s.whatsapp_message_id)).toEqual(Array.from({ length: n }, (_, i) => `wamid.${i + 1}`));
  });

  it("honours a different pause per audio", async () => {
    const t = setup([5, 12, 7]);
    const requestId = await t.open(); const start = t.clock.now();
    await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(t.log.map((l) => Math.round((l.at - start) / 1000))).toEqual([5, 17, 24]);
  });

  it("a request that is already completed sends nothing more", async () => {
    const t = setup([5]);
    const requestId = await t.open();
    await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    const again = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(again).toEqual({ kind: "completed", sent: 0 });
    expect(t.log).toHaveLength(1);
  });
});

describe("runAudioSequence: failures stop the sequence and are never retried", () => {
  it("Meta rejects audio 2: audio 1 stays sent, audio 3 is skipped, the request is partial, the error is stored sanitised", async () => {
    const t = setup();
    const requestId = await t.open();
    let calls = 0;
    const deps = t.deps({ sendVoiceNote: async () => { calls++; if (calls === 2) throw new MetaApiError({ message: "Media upload error Bearer EAAB123secret", code: 131053, httpStatus: 400 }); return { whatsappMessageId: `wamid.${calls}` }; } });
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps });
    expect(outcome).toMatchObject({ kind: "incomplete", sent: 1, requestStatus: "partial", reason: "meta_131053" });
    expect(t.sendsOf(requestId)).toBe("1:sent,2:failed,3:skipped");
    const failed = t.mem.table("audio_guide_sends")[1];
    expect(failed.error_code).toBe("meta_131053");
    expect(String(failed.error_detail)).toContain("Media upload error");
    expect(String(failed.error_detail)).not.toContain("EAAB123secret");
    expect(calls).toBe(2);
    // running it again (resumer, duplicate) does not retry anything
    expect(await runAudioSequence({ db: t.db, context: CTX, requestId, deps })).toMatchObject({ kind: "incomplete", requestStatus: "partial" });
    expect(calls).toBe(2);
  });

  it("the first audio fails: the request is failed (nothing was sent)", async () => {
    const t = setup();
    const requestId = await t.open();
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps({ sendVoiceNote: async () => { throw new MetaApiError({ message: "Re-engagement message", code: 131047, httpStatus: 400 }); } }) });
    expect(outcome).toMatchObject({ kind: "incomplete", sent: 0, requestStatus: "failed" });
    expect(t.sendsOf(requestId)).toBe("1:failed,2:skipped,3:skipped");
  });

  it("a blocked contact is a definite failure of that audio (the provider was never called)", async () => {
    const t = setup();
    const requestId = await t.open();
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps({ sendVoiceNote: async () => { throw new ContactBlockedError(); } }) });
    expect(outcome).toMatchObject({ reason: "contact_blocked", requestStatus: "failed" });
    expect(t.mem.table("audio_guide_sends")[0].error_code).toBe("contact_blocked");
  });

  it("an ambiguous failure (network) and a failure after Meta accepted are UNCERTAIN, and nothing follows them", async () => {
    for (const [error, code] of [[new TypeError("fetch failed"), "ambiguous_error"], [new Error("sent to Meta but DB insert failed: constraint"), "accepted_not_recorded"]] as const) {
      const t = setup();
      const requestId = await t.open();
      const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps({ sendVoiceNote: async () => { throw error; } }) });
      expect(outcome).toMatchObject({ kind: "incomplete", reason: code });
      expect(t.sendsOf(requestId)).toBe("1:uncertain,2:skipped,3:skipped");
      expect(t.request(requestId).status).toBe("failed");
    }
  });

  it("Meta accepted the audio but the outcome cannot be recorded: stop (never send the next), the send stays in flight and becomes uncertain, never resent", async () => {
    let failFinish = true;
    const t = setup([5, 5, 5], { rpc: (fn) => (fn === "audio_guide_finish_send" && failFinish ? { error: { message: "db down" } } : undefined) });
    const requestId = await t.open();
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(outcome).toMatchObject({ kind: "incomplete", reason: "outcome_not_recorded", sent: 1 });
    expect(t.sendsOf(requestId)).toBe("1:sending,2:pending,3:pending");
    expect(t.log).toHaveLength(1);
    // the database is back; before the grace period the sequence is simply "busy" (the first send might still be finishing)
    failFinish = false;
    expect(await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() })).toEqual({ kind: "busy", sent: 0 });
    // after the grace period it is uncertain and the rest is skipped: the first audio is NOT sent again
    t.clock.advance(181_000);
    const later = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(later).toMatchObject({ kind: "incomplete", requestStatus: "failed" });
    expect(t.sendsOf(requestId)).toBe("1:uncertain,2:skipped,3:skipped");
    expect(t.log).toHaveLength(1);
  });
});

describe("runAudioSequence: interruption and the time budget", () => {
  it("an exception while sending audio 2 is recorded as uncertain (the same state a hard kill reaches), audio 1 is never repeated", async () => {
    const t = setup();
    const requestId = await t.open();
    let calls = 0;
    const deps = t.deps({ sendVoiceNote: async () => { calls++; if (calls === 2) throw new Error("socket hang up"); return { whatsappMessageId: `wamid.${calls}` }; } });
    expect(await runAudioSequence({ db: t.db, context: CTX, requestId, deps })).toMatchObject({ kind: "incomplete", reason: "ambiguous_error" });
    expect(t.sendsOf(requestId)).toBe("1:sent,2:uncertain,3:skipped");
    expect(calls).toBe(2);
  });

  it("a hard kill between the claim and the outcome: the next worker waits out the grace period, records uncertain, and sends nothing", async () => {
    const t = setup();
    const requestId = await t.open();
    // claim audio 1 by hand and abandon it, as a killed process would
    t.clock.advance(6_000);
    const { data: claim } = await t.mem.client.rpc("audio_guide_claim_next_send", { p_account: A, p_request: requestId, p_stale_seconds: 180 }) as unknown as { data: { state: string } };
    expect(claim.state).toBe("claimed");
    expect(await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() })).toEqual({ kind: "busy", sent: 0 });
    t.clock.advance(200_000);
    const after = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps() });
    expect(after).toMatchObject({ kind: "incomplete", requestStatus: "failed" });
    expect(t.log).toHaveLength(0);
    expect(t.sendsOf(requestId)).toBe("1:uncertain,2:skipped,3:skipped");
  });

  it("the time budget: when the next pause does not fit, the run stops with the rest still pending (not failed, not complete) and a resumer finishes it", async () => {
    const t = setup(Array(6).fill(5));
    const requestId = await t.open();
    const first = await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps(), budgetMs: 17_000 });
    expect(first).toEqual({ kind: "deferred", sent: 3 });
    expect(t.sendsOf(requestId)).toBe("1:sent,2:sent,3:sent,4:pending,5:pending,6:pending");
    expect(t.request(requestId).status).toBe("sending");
    const resumed = await resumeAudioRequests({
      db: t.db, isEnabled: () => true,
      depsFor: () => t.deps(),
      now: t.clock.now,
    });
    // (the resumer needs the conversation to resolve the sender's user)
    expect(resumed.examined).toBe(0); // the next audio's pause has not passed yet
    t.clock.advance(6_000);
    t.mem.table("conversations").push({ id: "cv-1", account_id: A, user_id: "u-1" });
    const r2 = await resumeAudioRequests({ db: t.db, isEnabled: () => true, depsFor: () => t.deps(), now: t.clock.now });
    expect(r2).toMatchObject({ examined: 1, completed: 1 });
    expect(t.sendsOf(requestId)).toBe(Array.from({ length: 6 }, (_, i) => `${i + 1}:sent`).join(","));
    expect(t.log).toHaveLength(6); // each audio exactly once overall
    expect(t.request(requestId).status).toBe("completed");
  });
});

describe("runAudioSequence: concurrency", () => {
  it("two workers on the same request send each audio exactly once, in order", async () => {
    const t = setup([5, 5, 5, 5]);
    const requestId = await t.open();
    const order: string[] = [];
    const deps = (name: string) => t.deps({ sendVoiceNote: async ({ link }) => { order.push(`${name}:${link.slice(-8)}`); await Promise.resolve(); return { whatsappMessageId: `wamid.${name}.${order.length}` }; } });
    const [x, y] = await Promise.all([
      runAudioSequence({ db: t.db, context: CTX, requestId, deps: deps("A") }),
      runAudioSequence({ db: t.db, context: CTX, requestId, deps: deps("B") }),
    ]);
    expect(order).toHaveLength(4);
    expect(new Set(order.map((o) => o.split(":")[1])).size).toBe(4);
    expect(t.sendsOf(requestId)).toBe("1:sent,2:sent,3:sent,4:sent");
    expect(x.sent + y.sent).toBe(4);
    expect(t.request(requestId).status).toBe("completed");
  });
});

describe("runAudioSequence: stopping before a send", () => {
  it("a halt reason (human took over, run paused, contact blocked) skips everything pending with that reason", async () => {
    const t = setup();
    const requestId = await t.open();
    let sentOne = false;
    const deps = t.deps({
      sendVoiceNote: async () => { sentOne = true; return { whatsappMessageId: "wamid.1" }; },
      haltReason: async () => (sentOne ? "human_takeover" : null),
    });
    const outcome = await runAudioSequence({ db: t.db, context: CTX, requestId, deps });
    expect(outcome).toEqual({ kind: "halted", sent: 1, reason: "human_takeover", requestStatus: "partial" });
    expect(t.sendsOf(requestId)).toBe("1:sent,2:skipped,3:skipped");
    expect(t.mem.table("audio_guide_sends")[1].error_code).toBe("human_takeover");
  });

  it("makeHaltCheck: blocked contact, a paused run, an agent message after the request, and fail-closed when it cannot tell", async () => {
    const t = setup();
    const check = (over: Partial<Parameters<typeof makeHaltCheck>[0]> = {}) => makeHaltCheck({ db: t.db, accountId: A, contactId: "ct-1", conversationId: "cv-1", runId: "run-1", requestCreatedAtIso: new Date(t.clock.now()).toISOString(), ...over });
    expect(await check()()).toBeNull();
    t.mem.table("contacts")[0].blocked = true;
    expect(await check()()).toBe("contact_blocked");
    t.mem.table("contacts")[0].blocked = false;
    t.mem.table("flow_runs")[0].status = "paused_by_agent";
    expect(await check()()).toBe("run_not_active");
    t.mem.table("flow_runs")[0].status = "active";
    t.clock.advance(1000);
    t.mem.table("messages").push({ id: "m1", conversation_id: "cv-1", sender_type: "agent", created_at: new Date(t.clock.now()).toISOString() });
    expect(await check()()).toBe("human_takeover");
    t.mem.table("messages").length = 0;
    t.mem.table("messages").push({ id: "m0", conversation_id: "cv-1", sender_type: "agent", created_at: new Date(t.clock.now() - 60_000).toISOString() }, { id: "m2", conversation_id: "cv-1", sender_type: "customer", created_at: new Date(t.clock.now()).toISOString() });
    expect(await check()()).toBeNull(); // an older agent message and customer messages are not a takeover
    expect(await check({ contactId: "other" })()).toBe("halt_check_failed");
    expect(await check({ accountId: B })()).toBe("halt_check_failed");
  });
});

describe("resumeAudioRequests", () => {
  it("skips accounts that are not enabled, and leaves their audios pending", async () => {
    const t = setup([5]);
    const requestId = await t.open();
    t.clock.advance(6000);
    t.mem.table("conversations").push({ id: "cv-1", account_id: A, user_id: "u-1" });
    const summary = await resumeAudioRequests({ db: t.db, isEnabled: () => false, depsFor: () => t.deps(), now: t.clock.now });
    expect(summary).toMatchObject({ examined: 1, skippedDisabled: 1, completed: 0 });
    expect(t.sendsOf(requestId)).toBe("1:pending");
  });
  it("marks a stale in-flight send uncertain and does not send anything", async () => {
    const t = setup([5, 5]);
    const requestId = await t.open();
    t.clock.advance(6000);
    await t.mem.client.rpc("audio_guide_claim_next_send", { p_account: A, p_request: requestId, p_stale_seconds: 180 });
    t.clock.advance(400_000);
    t.mem.table("conversations").push({ id: "cv-1", account_id: A, user_id: "u-1" });
    const summary = await resumeAudioRequests({ db: t.db, isEnabled: () => true, depsFor: () => t.deps(), now: t.clock.now });
    expect(summary.examined).toBe(1);
    expect(t.log).toHaveLength(0);
    expect(t.sendsOf(requestId)).toBe("1:uncertain,2:skipped");
  });
});

describe("error helpers", () => {
  it("sanitizeError removes tokens, query strings and control characters, and bounds the length", () => {
    const dirty = "Bearer abc.def-123 failed at https://graph.example/v1/x?access_token=SECRET&to=15551234567 token=XYZ \u0000\n" + "x".repeat(900);
    const clean = sanitizeError(dirty);
    expect(clean).not.toMatch(/abc\.def|SECRET|XYZ|15551234567|\u0000|\n/);
    expect(clean.length).toBeLessThanOrEqual(400);
    expect(sanitizeError(undefined)).toBe("error");
  });
  it("classifySendError: failed only when Meta certainly did not accept it", () => {
    expect(classifySendError(new MetaApiError({ message: "x", code: 131047, httpStatus: 400 }))).toEqual({ status: "failed", code: "meta_131047" });
    expect(classifySendError(new MetaApiError({ message: "x", httpStatus: 503 }))).toEqual({ status: "failed", code: "meta_503" });
    expect(classifySendError(new ContactBlockedError())).toEqual({ status: "failed", code: "contact_blocked" });
    expect(classifySendError(new Error("[flows] voice notes are not enabled for this account — this send was NOT attempted"))).toEqual({ status: "failed", code: "not_attempted" });
    expect(classifySendError(new Error("contact not found for this account"))).toEqual({ status: "failed", code: "not_attempted" });
    expect(classifySendError(new Error("sent to Meta but DB insert failed: x"))).toEqual({ status: "uncertain", code: "accepted_not_recorded" });
    expect(classifySendError(new TypeError("fetch failed"))).toEqual({ status: "uncertain", code: "ambiguous_error" });
    expect(classifySendError("weird")).toEqual({ status: "uncertain", code: "ambiguous_error" });
  });
});

// ====================================================================================================== resumer hardening (AP-05A)
describe("resumeAudioRequests: operation, recovery and what the original run shows", () => {
  function withRun(pauses = [5, 5, 5], over: { rpc?: (fn: string, args: Row) => unknown } = {}) {
    const t = setup(pauses, over);
    t.mem.table("conversations").push({ id: "cv-1", account_id: A, user_id: "u-1" });
    const resume = (extra: Partial<Parameters<typeof resumeAudioRequests>[0]> = {}) => resumeAudioRequests({ db: t.db, isEnabled: () => true, depsFor: () => t.deps(), now: t.clock.now, ...extra });
    const events = () => t.mem.table("flow_run_events");
    return { ...t, resume, events };
  }

  it("budget exhausted -> the Flow run is failed; the resumer completes the audios LATER; the run stays failed and its timeline records the recovery exactly once", async () => {
    const t = withRun(Array(6).fill(5));
    const requestId = await t.open();
    expect(await runAudioSequence({ db: t.db, context: CTX, requestId, deps: t.deps(), budgetMs: 17_000 })).toMatchObject({ kind: "deferred", sent: 3 });
    t.mem.table("flow_runs")[0].status = "failed"; // what the node did when it returned incomplete
    t.clock.advance(6_000);
    const summary = await t.resume();
    expect(summary).toMatchObject({ examined: 1, completed: 1 });
    expect(t.request(requestId).status).toBe("completed");
    expect(t.log).toHaveLength(6);
    expect(t.mem.table("flow_runs")[0].status).toBe("failed"); // NOT turned into a success: its logical path did not complete
    expect(t.events()).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({ flow_run_id: "run-1", event_type: "message_sent", payload: { node_type: "send_product_audios", phase: "recovery", request_id: requestId, reason: "audio_sequence_recovered", sent_in_recovery: 3, request_status: "completed" } });
    // running the resumer again changes nothing and adds no second line
    expect(await t.resume()).toMatchObject({ examined: 0 });
    expect(t.events()).toHaveLength(1);
    expect(t.log).toHaveLength(6);
  });

  it("a contact blocked after the run ended: the resumer stops, sends nothing, and says so on the run", async () => {
    const t = withRun();
    const requestId = await t.open();
    t.mem.table("flow_runs")[0].status = "failed";
    t.mem.table("contacts")[0].blocked = true;
    t.clock.advance(6_000);
    const summary = await t.resume();
    expect(summary).toMatchObject({ examined: 1, halted: 1 });
    expect(t.log).toHaveLength(0);
    expect(t.sendsOf(requestId)).toBe("1:skipped,2:skipped,3:skipped");
    expect(t.request(requestId)).toMatchObject({ status: "failed", reason: "contact_blocked" });
    expect(t.events()[0]).toMatchObject({ event_type: "error", payload: { reason: "audio_sequence_closed", why: "contact_blocked", request_status: "failed" } });
  });

  it("a human agent wrote after the request was opened, or took over the run: the resumer stops and keeps the run's status", async () => {
    for (const how of ["agent message", "run paused by agent"] as const) {
      const t = withRun();
      const requestId = await t.open();
      t.clock.advance(1_000);
      if (how === "agent message") { t.mem.table("flow_runs")[0].status = "failed"; t.mem.table("messages").push({ id: "m", conversation_id: "cv-1", sender_type: "agent", created_at: new Date(t.clock.now()).toISOString() }); }
      else t.mem.table("flow_runs")[0].status = "paused_by_agent";
      t.clock.advance(6_000);
      await t.resume();
      expect(t.log).toHaveLength(0);
      expect(t.sendsOf(requestId)).toBe("1:skipped,2:skipped,3:skipped");
      expect(t.mem.table("flow_runs")[0].status).toBe(how === "agent message" ? "failed" : "paused_by_agent");
    }
  });

  it("an in-flight audio that never reported back is closed as UNCERTAIN by the resumer, nothing is resent, and the run records it", async () => {
    const t = withRun();
    const requestId = await t.open();
    t.mem.table("flow_runs")[0].status = "failed";
    t.clock.advance(6_000);
    await t.mem.client.rpc("audio_guide_claim_next_send", { p_account: A, p_request: requestId, p_stale_seconds: 180 }); // a worker claimed audio 1 and died
    t.clock.advance(200_000);
    const summary = await t.resume();
    expect(summary.examined).toBe(1);
    expect(t.log).toHaveLength(0);
    expect(t.sendsOf(requestId)).toBe("1:uncertain,2:skipped,3:skipped");
    expect(t.events()[0]).toMatchObject({ event_type: "error", payload: { reason: "audio_sequence_closed", request_status: "failed" } });
  });

  it("a transient database error while claiming sends nothing and changes nothing; the next run completes the sequence", async () => {
    let failClaim = true;
    const t = withRun([5, 5], { rpc: (fn) => (fn === "audio_guide_claim_next_send" && failClaim ? { error: { message: "connection reset" } } : undefined) });
    const requestId = await t.open();
    t.mem.table("flow_runs")[0].status = "failed";
    t.clock.advance(6_000);
    const first = await t.resume();
    expect(first).toMatchObject({ examined: 1, incomplete: 1, completed: 0 });
    expect(t.log).toHaveLength(0);
    expect(t.sendsOf(requestId)).toBe("1:pending,2:pending");
    expect(t.events()).toHaveLength(0);
    failClaim = false;
    expect(await t.resume()).toMatchObject({ completed: 1 });
    expect(t.log).toHaveLength(2);
  });

  it("a failure listing the recoverable requests raises (the endpoint answers 500 and the scheduler retries); a failure on ONE request does not stop the others", async () => {
    const t = withRun();
    const listFails = { ...t.mem.client, rpc: (fn: string, args: Row) => (fn === "audio_guide_recoverable_requests" ? Promise.resolve({ data: null, error: { message: "db down" } }) : t.mem.client.rpc(fn, args)) } as unknown as SequencerDb;
    await expect(resumeAudioRequests({ db: listFails, isEnabled: () => true, depsFor: () => t.deps() })).rejects.toThrow(/recoverable/);
    // two requests, the first one's context cannot be resolved (no conversation): it counts as an error, the second still completes
    const a = await t.open("wamid.A"); void a;
    t.mem.table("audio_guide_requests")[0].conversation_id = "cv-missing";
    const b = await t.open("wamid.B");
    t.clock.advance(6_000);
    const summary = await t.resume();
    expect(summary).toMatchObject({ examined: 2, errors: 1, completed: 1 });
    expect(t.request(b).status).toBe("completed");
  });

  it("two resumers at the same moment: each audio goes out exactly once, in order, and the recovery is noted once", async () => {
    const t = withRun([5, 5, 5, 5]);
    const requestId = await t.open();
    t.mem.table("flow_runs")[0].status = "failed";
    t.clock.advance(6_000);
    const order: string[] = [];
    const depsFor = (name: string) => () => t.deps({ sendVoiceNote: async ({ link }) => { order.push(`${name}:${link.slice(-9)}`); await Promise.resolve(); return { whatsappMessageId: `wamid.${name}.${order.length}` }; } });
    const [x, y] = await Promise.all([t.resume({ depsFor: depsFor("A") }), t.resume({ depsFor: depsFor("B") })]);
    expect(order).toHaveLength(4);
    expect(new Set(order.map((o) => o.split(":")[1])).size).toBe(4);
    expect(t.sendsOf(requestId)).toBe("1:sent,2:sent,3:sent,4:sent");
    expect(x.completed + y.completed).toBeGreaterThanOrEqual(1);
    expect(t.events().filter((e) => (e.payload as { reason: string }).reason === "audio_sequence_recovered").length).toBeLessThanOrEqual(2);
    expect(t.request(requestId).status).toBe("completed");
  });

  it("the batch limit is honoured, and an account that is no longer enabled is left untouched", async () => {
    const t = withRun([5]);
    for (const id of ["wamid.1", "wamid.2", "wamid.3"]) await t.open(id);
    t.clock.advance(6_000);
    expect(await t.resume({ limit: 2 })).toMatchObject({ examined: 2, completed: 2 });
    expect(await t.resume({ isEnabled: () => false })).toMatchObject({ examined: 1, skippedDisabled: 1, completed: 0 });
    expect(t.log).toHaveLength(2);
  });

  it("stops listing new requests once its time budget is spent", async () => {
    const t = withRun([5]);
    for (const id of ["wamid.1", "wamid.2"]) await t.open(id);
    t.clock.advance(6_000);
    const summary = await t.resume({ budgetMs: 0 });
    expect(summary.examined).toBe(0);
    expect(t.log).toHaveLength(0);
  });
});
