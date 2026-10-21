// @vitest-environment node
/**
 * QA of the "Audios por producto" executor against a REAL PostgreSQL (the isolated staging, migrations 001..075, PostgREST) with a SIMULATED
 * Meta. The runner, the node, the sequencer and engineSendMedia are the production code; only the call that would reach Meta is replaced.
 * Skipped unless QA_STORAGE_URL is set. Synthetic accounts, contacts, products and files; nothing is sent to WhatsApp.
 *
 *   qa/audio-guide/run-sequencer-qa.sh
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const meta = vi.hoisted(() => ({ calls: [] as Array<{ at: number; kind: string; voice?: boolean; link: string; to: string; caption?: unknown; filename?: unknown }>, behave: null as null | ((n: number) => Promise<void>) }));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: async (a: { kind: string; voice?: boolean; link: string; to: string; caption?: unknown; filename?: unknown }) => {
    meta.calls.push({ at: Date.now(), kind: a.kind, voice: a.voice, link: a.link, to: a.to, caption: a.caption, filename: a.filename });
    if (meta.behave) await meta.behave(meta.calls.length);
    return { messageId: `wamid.QA.${meta.calls.length}.${Math.random().toString(36).slice(2, 8)}` };
  },
}));

import { MetaApiError } from "@/lib/whatsapp/meta-api";
import { encrypt } from "@/lib/whatsapp/encryption";
import { dispatchInboundToFlows } from "@/lib/flows/engine";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { executeSendProductAudios } from "@/lib/flows/product-audios";
import { inspectVoiceNote, sha256Hex } from "@/lib/media/voice-note";
import { resumeAudioRequests, runAudioSequence, type SequencerDb } from "./sequencer";
import { sendVoiceNoteViaEngine } from "./sender";
import { listRecentRequests } from "./requests";
import { readAudioGuideHealth } from "./health";

const env = process.env;
const ENABLED = Boolean(env.QA_STORAGE_URL);
const sql = (q: string) => execFileSync("docker", ["exec", "-i", env.QA_DB_CONTAINER!, "psql", "-U", "supabase_admin", "-h", "/var/run/postgresql", "-d", "postgres", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const q1 = (s: string) => s.replace(/'/g, "''");
const FIX = "src/lib/media/test-support/fixtures";
const FILES = ["real-mono-opus.ogg", "real-mono-opus-b.ogg", "real-mono-opus-c.ogg", "real-mono-opus-4.ogg", "real-mono-opus-5.ogg", "real-mono-opus-6.ogg", "real-mono-opus-7.ogg"];
const run = Date.now().toString(36);

let accountA = "", accountB = "", userA = "", userB = "", tagA = "", tagB = "", fieldA = "", flowId = "";
const shas: string[] = [];
let admin: SupabaseClient;
let phoneSeq = 0;

async function seedProduct(account: string, key: string, count: number, opts: { active?: boolean; disabled?: number[]; pauses?: number[] } = {}) {
  const id = sql(`insert into public.audio_guide_products (account_id, product_key, display_name, active) values ('${account}', '${q1(key)}', '${q1(key)}', ${opts.active === false ? "false" : "true"}) returning id`).split("\n")[0];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(readFileSync(`${FIX}/${FILES[i]}`));
    const v = inspectVoiceNote(bytes);
    if (!v.ok) throw new Error("fixture invalid");
    const status = opts.disabled?.includes(i + 1) ? "disabled" : "active";
    sql(`insert into public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms, pre_delay_seconds, status) values ('${account}', '${id}', ${i + 1}, '${shas[i]}', 'account-${account}/${shas[i]}.ogg', ${v.bytes}, ${v.durationMs}, ${opts.pauses?.[i] ?? 5}, '${status}')`);
  }
  return id;
}

async function newContact(o: { product?: string | null; tagged?: boolean; blocked?: boolean; account?: string; user?: string; tag?: string; field?: string } = {}) {
  const account = o.account ?? accountA, user = o.user ?? userA;
  const phone = `+1555${String(7000000 + ++phoneSeq + Math.floor(Math.random() * 1000) * 1000)}`.slice(0, 12);
  const contact = sql(`insert into public.contacts (account_id, user_id, phone, name, blocked) values ('${account}', '${user}', '${phone}', 'QA ${run}', ${o.blocked ? "true" : "false"}) returning id`).split("\n")[0];
  const conv = sql(`insert into public.conversations (account_id, user_id, contact_id) values ('${account}', '${user}', '${contact}') returning id`).split("\n")[0];
  if (o.tagged !== false) sql(`insert into public.contact_tags (contact_id, tag_id) values ('${contact}', '${o.tag ?? tagA}')`);
  if (o.product !== null && o.product !== undefined) sql(`insert into public.contact_custom_values (contact_id, custom_field_id, value) values ('${contact}', '${o.field ?? fieldA}', '${q1(o.product)}')`);
  return { contact, conv, phone };
}
const inbound = (c: { contact: string; conv: string }, id = `wamid.IN.${run}.${Math.random().toString(36).slice(2, 10)}`, text = "provincia", account = accountA, user = userA) =>
  dispatchInboundToFlows({ accountId: account, userId: user, contactId: c.contact, conversationId: c.conv, message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false });
const q = (s: string) => sql(s).split("\n").filter(Boolean);
const requestOf = (contact: string) => sql(`select status || '|' || coalesce(reason, '') || '|' || trigger_message_id from public.audio_guide_requests where contact_id = '${contact}' order by created_at desc limit 1`);
const sendsOf = (contact: string) => sql(`select coalesce(string_agg(s.position || ':' || s.status, ',' order by s.position), '') from public.audio_guide_sends s join public.audio_guide_requests r on r.id = s.request_id where r.contact_id = '${contact}'`);
const runOf = (contact: string) => sql(`select status || '|' || coalesce(end_reason, '') from public.flow_runs where contact_id = '${contact}' order by started_at desc limit 1`);
const url = (n: number) => `${env.QA_STORAGE_URL}/storage/v1/object/public/voice-notes/account-${accountA}/${shas[n - 1]}.ogg`;
const secs = (calls: Array<{ at: number }>, t0: number) => calls.map((c) => Math.round((c.at - t0) / 100) / 10);
const near = (actual: number[], expected: number[], tol = 1.6) => actual.length === expected.length && actual.every((a, i) => Math.abs(a - expected[i]) <= tol);

describe.skipIf(!ENABLED)("audio guide executor against real PostgreSQL (simulated Meta)", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.QA_STORAGE_URL!;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.QA_SERVICE_KEY!;
    admin = createClient(env.QA_STORAGE_URL!, env.QA_SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    accountA = sql(`select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='${env.QA_USER_A_EMAIL}'`);
    accountB = sql(`select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='${env.QA_USER_B_EMAIL}'`);
    userA = sql(`select u.id from auth.users u where u.email='${env.QA_USER_A_EMAIL}'`);
    userB = sql(`select u.id from auth.users u where u.email='${env.QA_USER_B_EMAIL}'`);
    process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS = accountA;
    // a clean slate, so the QA can be repeated on the same staging (all of it is synthetic data of this QA)
    sql(`delete from public.audio_guide_requests where account_id in ('${accountA}', '${accountB}')`);
    sql(`delete from public.audio_guide_products where account_id in ('${accountA}', '${accountB}')`);
    sql(`delete from public.flows where account_id = '${accountA}' and name like '% QA %'`);
    sql(`delete from public.contacts where account_id in ('${accountA}', '${accountB}') and name like 'QA %'`);
    sql(`delete from public.custom_fields where account_id = '${accountA}' and lower(btrim(field_name)) = 'producto'`);
    sql(`delete from public.tags where name like 'audio-guia-%'`);
    sql(`delete from public.whatsapp_config where account_id = '${accountA}'`);
    // real voice-note files of both accounts, stored the way the server stores them
    for (const [i, name] of FILES.entries()) {
      const bytes = new Uint8Array(readFileSync(`${FIX}/${name}`));
      const sha = await sha256Hex(bytes);
      shas.push(sha);
      for (const account of [accountA, accountB]) {
        const { error } = await admin.storage.from("voice-notes").upload(`account-${account}/${sha}.ogg`, bytes, { contentType: "audio/ogg", upsert: false });
        if (error && !/exists|Duplicate/i.test(error.message)) throw new Error(`upload ${i}: ${error.message}`);
      }
    }
    sql(`insert into public.whatsapp_config (user_id, account_id, phone_number_id, access_token, status) values ('${userA}', '${accountA}', 'pn-qa-${run}', '${q1(encrypt("synthetic-token"))}', 'connected') on conflict do nothing`);
    tagA = sql(`insert into public.tags (account_id, user_id, name) values ('${accountA}', '${userA}', 'audio-guia-${run}') returning id`).split("\n")[0];
    tagB = sql(`insert into public.tags (account_id, user_id, name) values ('${accountB}', '${userB}', 'audio-guia-${run}') returning id`).split("\n")[0];
    fieldA = sql(`insert into public.custom_fields (account_id, user_id, field_name) values ('${accountA}', '${userA}', 'Producto') returning id`).split("\n")[0];
    await seedProduct(accountA, "uno", 1);
    await seedProduct(accountA, "tres", 3);
    await seedProduct(accountA, "seis", 6);
    await seedProduct(accountA, "sin audios", 0);
    await seedProduct(accountA, "inactivo", 2, { active: false });
    await seedProduct(accountA, "apagados", 2, { disabled: [1, 2] });
    await seedProduct(accountA, "parcial", 3, { disabled: [2] });
    await seedProduct(accountB, "solo en b", 2);
    await seedProduct(accountB, "tres", 2);
    // the ONE Flow: keyword trigger -> send_product_audios (gate inside) -> four terminal routes
    flowId = sql(`insert into public.flows (account_id, user_id, name, trigger_type, trigger_config, entry_node_id, status) values ('${accountA}', '${userA}', 'Audios por producto QA ${run}', 'keyword', '{"keywords":["provincia"],"match_type":"contains"}', 'start', 'active') returning id`).split("\n")[0];
    const cfg = JSON.stringify({ gate_tag_id: tagA, product_field_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "gate" });
    sql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${flowId}', 'start', 'start', '{"next_node_key":"vp"}'), ('${flowId}', 'vp', 'send_product_audios', '${q1(cfg)}'), ('${flowId}', 'ok', 'end', '{}'), ('${flowId}', 'unk', 'end', '{}'), ('${flowId}', 'noa', 'end', '{}'), ('${flowId}', 'gate', 'end', '{}')`);
  }, 120_000);

  afterAll(() => { meta.behave = null; });

  const reset = () => { meta.calls.length = 0; meta.behave = null; };

  describe("a sequence of 1, 3 and 6 audios through the real runner", () => {
    it.each([[1, "uno"], [3, "tres"], [6, "seis"]] as const)("Q1-3: %i audio(s) (product %s): voice notes, in order, 5 s before each, persisted, completed", async (n, product) => {
      reset();
      const c = await newContact({ product });
      const t0 = Date.now();
      const result = await inbound(c);
      expect(result).toMatchObject({ consumed: true, outcome: "completed" });
      const times = secs(meta.calls, t0);
      console.log(`QA-EVIDENCE ${n} audio(s): Meta calls at +${times.join("s, +")}s; sends=${sendsOf(c.contact)}; request=${requestOf(c.contact).split("|").slice(0, 2).join("/")}; run=${runOf(c.contact)}`);
      expect(meta.calls.map((x) => x.link)).toEqual(Array.from({ length: n }, (_, i) => url(i + 1)));
      expect(meta.calls.every((x) => x.kind === "audio" && x.voice === true && x.caption === undefined && x.filename === undefined)).toBe(true);
      expect(near(times, Array.from({ length: n }, (_, i) => 5 * (i + 1)))).toBe(true);
      expect(sendsOf(c.contact)).toBe(Array.from({ length: n }, (_, i) => `${i + 1}:sent`).join(","));
      expect(requestOf(c.contact).startsWith("completed|")).toBe(true);
      expect(runOf(c.contact)).toBe("completed|end_node");
      expect(q(`select content_type || ':' || sender_type from public.messages where conversation_id = '${c.conv}' order by created_at`)).toEqual(Array(n).fill("audio:bot"));
      expect(q(`select count(distinct whatsapp_message_id) from public.audio_guide_sends s join public.audio_guide_requests r on r.id = s.request_id where r.contact_id = '${c.contact}' and s.whatsapp_message_id is not null`)).toEqual([String(n)]);
    }, 120_000);

    it("Q4 only ACTIVE audios, in order (a disabled one in the middle is skipped)", async () => {
      reset();
      const c = await newContact({ product: "Parcial" });
      await inbound(c);
      expect(meta.calls.map((x) => x.link)).toEqual([url(1), url(3)]);
      expect(sendsOf(c.contact)).toBe("1:sent,2:sent");
    }, 60_000);
  });

  describe("safe routes: nothing is sent", () => {
    it.each([
      ["no Producto value", { product: null }, "unk", "no_value"],
      ["a blank value", { product: "   " }, "unk", "no_value"],
      ["an unknown product", { product: "no existe" }, "unk", "unknown_product"],
      ["an inactive product", { product: "inactivo" }, "unk", "product_inactive"],
      ["a product with no audios", { product: "sin audios" }, "noa", "no_audios"],
      ["a product whose audios are all disabled", { product: "apagados" }, "noa", "no_audios"],
      ["the gate closed (contact without the tag)", { product: "uno", tagged: false }, "gate", "gate_closed"],
    ])("Q5 %s -> %s", async (_name, over, route, reason) => {
      reset();
      const c = await newContact(over);
      await inbound(c);
      expect(meta.calls).toHaveLength(0);
      expect(requestOf(c.contact)).toMatch(new RegExp(`^skipped\\|${reason}\\|`));
      expect(q(`select node_key from public.flow_run_events e join public.flow_runs r on r.id = e.flow_run_id where r.contact_id = '${c.contact}' and e.event_type = 'node_entered' order by e.created_at`)).toEqual(["start", "vp", route]);
      expect(runOf(c.contact)).toBe("completed|end_node");
    }, 30_000);

    it("Q6 another account's product, audios and tag are never used (account isolation)", async () => {
      reset();
      const c = await newContact({ product: "solo en b" });
      await inbound(c);
      expect(meta.calls).toHaveLength(0);
      expect(requestOf(c.contact)).toMatch(/^skipped\|unknown_product\|/);
      // the same product key exists in B with 2 audios, and in A with 3: A's contact gets A's
      reset();
      const d = await newContact({ product: "tres" });
      await inbound(d);
      expect(meta.calls.map((x) => x.link)).toEqual([url(1), url(2), url(3)]);
      expect(sql(`select count(*) from public.audio_guide_requests where account_id = '${accountB}'`)).toBe("0");
      // a gate tag that belongs to another account fails closed
      sql(`update public.flow_nodes set config = jsonb_set(config, '{gate_tag_id}', '"${tagB}"') where flow_id = '${flowId}' and node_key = 'vp'`);
      try {
        reset();
        const e = await newContact({ product: "uno" });
        await inbound(e);
        expect(meta.calls).toHaveLength(0);
        expect(runOf(e.contact)).toBe("failed|gate_tag_not_in_account");
      } finally { sql(`update public.flow_nodes set config = jsonb_set(config, '{gate_tag_id}', '"${tagA}"') where flow_id = '${flowId}' and node_key = 'vp'`); }
    }, 60_000);

    it("Q7 an ambiguous or missing Producto field is never guessed", async () => {
      reset();
      const dup = sql(`insert into public.custom_fields (account_id, user_id, field_name) values ('${accountA}', '${userA}', ' PRODUCTO ') returning id`).split("\n")[0];
      try {
        const c = await newContact({ product: "uno" });
        await inbound(c);
        expect(meta.calls).toHaveLength(0);
        expect(runOf(c.contact)).toBe("failed|product_field_ambiguous");
      } finally { sql(`delete from public.custom_fields where id = '${dup}'`); }
    }, 30_000);
  });

  describe("duplicates and concurrency", () => {
    it("Q8 the same inbound message delivered twice at once, and again afterwards, sends the sequence ONCE", async () => {
      reset();
      const c = await newContact({ product: "tres" });
      const id = `wamid.DUP.${run}`;
      const [a, b] = await Promise.all([inbound(c, id), inbound(c, id)]);
      expect([a.consumed, b.consumed]).toEqual([true, true]);
      await inbound(c, id);
      expect(meta.calls).toHaveLength(3);
      expect(q(`select count(*) from public.audio_guide_requests where contact_id = '${c.contact}'`)).toEqual(["1"]);
      expect(sendsOf(c.contact)).toBe("1:sent,2:sent,3:sent");
    }, 90_000);

    it("Q9 two contacts at the same time: each gets its own full sequence, in order", async () => {
      reset();
      const [c1, c2] = [await newContact({ product: "tres" }), await newContact({ product: "tres" })];
      await Promise.all([inbound(c1), inbound(c2)]);
      expect(meta.calls).toHaveLength(6);
      for (const c of [c1, c2]) {
        expect(sendsOf(c.contact)).toBe("1:sent,2:sent,3:sent");
        expect(meta.calls.filter((x) => x.to === c.phone.replace("+", "")).map((x) => x.link)).toEqual([url(1), url(2), url(3)]);
      }
    }, 90_000);

    it("Q10 two workers on the SAME request (the Flow node and a resumer racing): each audio exactly once, in order", async () => {
      reset();
      const c = await newContact({ product: "tres" });
      const { data } = await admin.rpc("audio_guide_open_request", { p_account: accountA, p_contact: c.contact, p_conversation: c.conv, p_run: null, p_trigger: `wamid.RACE.${run}`, p_product_key: "tres", p_expected_revision: null });
      const requestId = (data as { request_id: string }).request_id;
      const order: string[] = [];
      const worker = (name: string) => runAudioSequence({ db: admin as unknown as SequencerDb, context: { accountId: accountA, userId: userA, conversationId: c.conv, contactId: c.contact }, requestId, deps: { sendVoiceNote: async ({ link }) => { order.push(`${name}:${link.slice(-12)}`); return { whatsappMessageId: `wamid.RACE.${order.length}` }; } } });
      const [x, y] = await Promise.all([worker("A"), worker("B")]);
      expect(order).toHaveLength(3);
      expect(new Set(order.map((o) => o.split(":")[1])).size).toBe(3);
      expect(order.map((o) => o.split(":")[1])).toEqual([1, 2, 3].map((n) => shas[n - 1].slice(-8) + ".ogg"));
      expect(sendsOf(c.contact)).toBe("1:sent,2:sent,3:sent");
      expect(x.sent + y.sent).toBe(3);
    }, 90_000);

    it("Q11 two simultaneous claims of the same due audio: exactly one wins (real row locks)", async () => {
      const c = await newContact({ product: "uno" });
      const { data } = await admin.rpc("audio_guide_open_request", { p_account: accountA, p_contact: c.contact, p_conversation: c.conv, p_run: null, p_trigger: `wamid.CLAIM.${run}`, p_product_key: "uno", p_expected_revision: null });
      const requestId = (data as { request_id: string }).request_id;
      sql(`update public.audio_guide_sends set not_before = now() - interval '1 second' where request_id = '${requestId}'`);
      const results = await Promise.all(Array.from({ length: 6 }, () => admin.rpc("audio_guide_claim_next_send", { p_account: accountA, p_request: requestId })));
      const states = results.map((r) => (r.data as { state: string }).state).sort();
      expect(states).toEqual(["busy", "busy", "busy", "busy", "busy", "claimed"]);
      await admin.rpc("audio_guide_halt_request", { p_account: accountA, p_request: requestId, p_reason: "qa_cleanup" });
    });

    it("Q12 six simultaneous openings of the same inbound message create ONE request", async () => {
      const c = await newContact({ product: "uno" });
      const results = await Promise.all(Array.from({ length: 6 }, () => admin.rpc("audio_guide_open_request", { p_account: accountA, p_contact: c.contact, p_conversation: c.conv, p_run: null, p_trigger: `wamid.OPEN.${run}`, p_product_key: "uno", p_expected_revision: null })));
      const created = results.filter((r) => (r.data as { created?: boolean }).created === true);
      expect(created).toHaveLength(1);
      expect(new Set(results.map((r) => (r.data as { request_id: string }).request_id)).size).toBe(1);
      expect(q(`select count(*) from public.audio_guide_sends where request_id = '${(created[0].data as { request_id: string }).request_id}'`)).toEqual(["1"]);
      await admin.rpc("audio_guide_halt_request", { p_account: accountA, p_request: (created[0].data as { request_id: string }).request_id, p_reason: "qa_cleanup" });
    });
  });

  describe("failures never look like success, and nothing uncertain is retried", () => {
    it("Q13 Meta rejects audio 2: audio 3 is never sent, the request is partial, the run FAILS", async () => {
      reset();
      meta.behave = async (n) => { if (n === 2) throw new MetaApiError({ message: "Media upload error", code: 131053, httpStatus: 400 }); };
      const c = await newContact({ product: "tres" });
      await inbound(c);
      expect(meta.calls).toHaveLength(2);
      expect(sendsOf(c.contact)).toBe("1:sent,2:failed,3:skipped");
      expect(requestOf(c.contact)).toMatch(/^partial\|/);
      expect(runOf(c.contact)).toBe("failed|audio_sequence_incomplete");
      expect(sql(`select error_code from public.audio_guide_sends s join public.audio_guide_requests r on r.id = s.request_id where r.contact_id = '${c.contact}' and s.position = 2`)).toBe("meta_131053");
    }, 60_000);

    it("Q14 the database cannot record the outcome after Meta accepted: the run fails, nothing more is sent, and the resumer later records it UNCERTAIN without resending", async () => {
      reset();
      const adminClient = supabaseAdmin();
      const realRpc = adminClient.rpc.bind(adminClient);
      let failing = true;
      (adminClient as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) =>
        fn === "audio_guide_finish_send" && failing ? Promise.resolve({ data: null, error: { message: "db down" } }) : realRpc(fn, args as never);
      try {
        const c = await newContact({ product: "tres" });
        await inbound(c);
        expect(meta.calls).toHaveLength(1);
        expect(sendsOf(c.contact)).toBe("1:sending,2:pending,3:pending");
        expect(runOf(c.contact)).toBe("failed|audio_sequence_incomplete");
        failing = false;
        // not stale yet: the resumer leaves it alone
        const early = await resumeAudioRequests({ db: admin as unknown as SequencerDb, isEnabled: () => true, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
        void early; // (other tests' requests are all final or halted by now; this one is not stale yet and must be left alone)
        expect(sendsOf(c.contact)).toBe("1:sending,2:pending,3:pending");
        expect(meta.calls).toHaveLength(1);
        sql(`update public.audio_guide_sends s set started_at = now() - interval '10 minutes' from public.audio_guide_requests r where r.id = s.request_id and r.contact_id = '${c.contact}' and s.status = 'sending'`);
        const late = await resumeAudioRequests({ db: admin as unknown as SequencerDb, isEnabled: (a) => a === accountA, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
        expect(late.examined).toBeGreaterThanOrEqual(1);
        expect(meta.calls).toHaveLength(1);
        expect(sendsOf(c.contact)).toBe("1:uncertain,2:skipped,3:skipped");
      } finally { (adminClient as unknown as { rpc: unknown }).rpc = realRpc; }
    }, 60_000);

    it("Q15 restart in the middle: a worker that claimed an audio and died is recorded uncertain after the grace period; the other audios are not sent out of order; nothing is resent", async () => {
      reset();
      const c = await newContact({ product: "tres" });
      const { data } = await admin.rpc("audio_guide_open_request", { p_account: accountA, p_contact: c.contact, p_conversation: c.conv, p_run: null, p_trigger: `wamid.KILL.${run}`, p_product_key: "tres", p_expected_revision: null });
      const requestId = (data as { request_id: string }).request_id;
      sql(`update public.audio_guide_sends set not_before = now() - interval '1 second' where request_id = '${requestId}' and position = 1`);
      const first = await admin.rpc("audio_guide_claim_next_send", { p_account: accountA, p_request: requestId }); // ...and the process dies here
      expect((first.data as { state: string }).state).toBe("claimed");
      const worker = () => runAudioSequence({ db: admin as unknown as SequencerDb, context: { accountId: accountA, userId: userA, conversationId: c.conv, contactId: c.contact }, requestId, deps: { sendVoiceNote: async () => { throw new Error("must not send"); } } });
      expect(await worker()).toEqual({ kind: "busy", sent: 0 });
      sql(`update public.audio_guide_sends set started_at = now() - interval '10 minutes' where request_id = '${requestId}' and status = 'sending'`);
      expect(await worker()).toMatchObject({ kind: "incomplete", requestStatus: "failed" });
      expect(sendsOf(c.contact)).toBe("1:uncertain,2:skipped,3:skipped");
      expect(meta.calls).toHaveLength(0);
    }, 60_000);

    it("Q16 the inline time budget runs out: the rest stays pending, the run FAILS (not complete), and the resumer finishes it, each audio once overall", async () => {
      reset();
      const c = await newContact({ product: "tres" });
      const { data: run0 } = await admin.from("flow_runs").insert({ flow_id: flowId, account_id: accountA, user_id: userA, contact_id: c.contact, conversation_id: c.conv, status: "active", current_node_key: "vp", vars: {} }).select("*").single();
      const cfg = { gate_tag_id: tagA, product_field_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "gate" };
      const result = await executeSendProductAudios({ db: admin as never, run: run0 as never, nodeKey: "vp", config: cfg, deps: { budgetMs: 7_000 } });
      expect(result).toMatchObject({ kind: "failed", reason: "audio_sequence_incomplete", detail: { sent: 1, why: "time_budget", resumable: true } });
      expect(meta.calls).toHaveLength(1);
      expect(sendsOf(c.contact)).toBe("1:sent,2:pending,3:pending");
      expect(requestOf(c.contact)).toMatch(/^sending\|/);
      await admin.from("flow_runs").update({ status: "failed", end_reason: "audio_sequence_incomplete" }).eq("id", (run0 as { id: string }).id);
      // the next pause has not passed: nothing is due
      const t0 = Date.now();
      let summary = await resumeAudioRequests({ db: admin as unknown as SequencerDb, isEnabled: (a) => a === accountA, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }), budgetMs: 30_000 });
      // the resumer may or may not find it due yet; keep resuming until the sequence is complete
      for (let i = 0; i < 8 && !requestOf(c.contact).startsWith("completed"); i++) {
        await new Promise((r) => setTimeout(r, 2500));
        summary = await resumeAudioRequests({ db: admin as unknown as SequencerDb, isEnabled: (a) => a === accountA, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }), budgetMs: 30_000 });
      }
      void t0; void summary;
      expect(requestOf(c.contact)).toMatch(/^completed\|/);
      expect(meta.calls.map((x) => x.link)).toEqual([url(1), url(2), url(3)]);
      expect(sendsOf(c.contact)).toBe("1:sent,2:sent,3:sent");
      // the run is NOT turned into a success; its timeline says what became of the audios, once
      const rid = (run0 as { id: string }).id;
      expect(sql(`select status || '|' || end_reason from public.flow_runs where id = '${rid}'`)).toBe("failed|audio_sequence_incomplete");
      expect(q(`select payload->>'reason' || '|' || (payload->>'sent_in_recovery') from public.flow_run_events where flow_run_id = '${rid}' and payload->>'phase' = 'recovery'`)).toEqual(["audio_sequence_recovered|2"]);
    }, 120_000);
  });

  describe("people, contacts and other flows", () => {
    it("Q17 a blocked contact: nothing is sent, the run ends as the block route does", async () => {
      reset();
      const c = await newContact({ product: "tres", blocked: true });
      // a blocked contact is stopped by the webhook before any flow; here the block lands while the run is live, so start the run directly
      const result = await inbound(c);
      void result;
      expect(meta.calls).toHaveLength(0);
      expect(requestOf(c.contact)).toMatch(/^failed\|contact_blocked\|/);
      expect(runOf(c.contact)).toBe("paused_by_agent|contact_blocked");
    }, 30_000);

    it("Q18 a human agent steps in during the sequence: the rest is skipped and the run keeps its paused status", async () => {
      reset();
      const c = await newContact({ product: "tres" });
      meta.behave = async (n) => {
        if (n === 1) {
          sql(`update public.flow_runs set status = 'paused_by_agent' where contact_id = '${c.contact}' and status = 'active'`);
          sql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${c.conv}', 'agent', 'text', 'Hola, soy una persona', 'wamid.AGENT.${run}.${n}', 'sent')`);
        }
      };
      await inbound(c);
      expect(meta.calls).toHaveLength(1);
      expect(sendsOf(c.contact)).toBe("1:sent,2:skipped,3:skipped");
      expect(runOf(c.contact)).toBe("paused_by_agent|");
      expect(requestOf(c.contact)).toMatch(/^partial\|run_not_active\|/);
    }, 60_000);

    it("Q19 a contact with a COMMERCIAL flow already running: the message goes to that run, the audio flow does not start, no audio is sent", async () => {
      reset();
      const commercial = sql(`insert into public.flows (account_id, user_id, name, trigger_type, trigger_config, entry_node_id, status, created_at) values ('${accountA}', '${userA}', 'Comercial QA ${run}', 'keyword', '{"keywords":["hola ${run}"]}', 'ask', 'active', now() - interval '1 day') returning id`).split("\n")[0];
      sql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${commercial}', 'ask', 'collect_input', '{"prompt_text":"Ciudad?","var_key":"ciudad","next_node_key":"fin"}'), ('${commercial}', 'fin', 'end', '{}')`);
      const c = await newContact({ product: "uno" });
      sql(`insert into public.flow_runs (flow_id, account_id, user_id, contact_id, conversation_id, status, current_node_key, vars) values ('${commercial}', '${accountA}', '${userA}', '${c.contact}', '${c.conv}', 'active', 'ask', '{}')`);
      await inbound(c, undefined, "provincia");
      expect(meta.calls).toHaveLength(0);
      expect(q(`select count(*) from public.audio_guide_requests where contact_id = '${c.contact}'`)).toEqual(["0"]);
      expect(sql(`select vars->>'ciudad' from public.flow_runs where flow_id = '${commercial}' and contact_id = '${c.contact}'`)).toBe("provincia");
      expect(sql(`select count(*) from public.flow_runs where flow_id = '${flowId}' and contact_id = '${c.contact}'`)).toBe("0");
    }, 30_000);

    it("Q20 a flow WITHOUT the new node runs exactly as before (regression)", async () => {
      reset();
      const plain = sql(`insert into public.flows (account_id, user_id, name, trigger_type, trigger_config, entry_node_id, status) values ('${accountA}', '${userA}', 'Plano QA ${run}', 'keyword', '{"keywords":["plano ${run}"]}', 'start', 'active') returning id`).split("\n")[0];
      sql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${plain}', 'start', 'start', '{"next_node_key":"fin"}'), ('${plain}', 'fin', 'end', '{}')`);
      const c = await newContact({ product: "uno" });
      const result = await inbound(c, undefined, `plano ${run}`);
      expect(result).toMatchObject({ consumed: true, outcome: "completed" });
      expect(runOf(c.contact)).toBe("completed|end_node");
      expect(meta.calls).toHaveLength(0);
    }, 30_000);
  });

  describe("the resumer, its endpoint and what the operator sees (AP-05A)", () => {
    const SECRET = "qa-cron-secret-0123456789-abcdefghij";
    const resumer = (accounts = [accountA]) => resumeAudioRequests({ db: admin as unknown as SequencerDb, isEnabled: (a) => accounts.includes(a), depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }), budgetMs: 40_000 });
    async function pendingRequest(product: string, trigger: string) {
      const c = await newContact({ product });
      const { data: runRow } = await admin.from("flow_runs").insert({ flow_id: flowId, account_id: accountA, user_id: userA, contact_id: c.contact, conversation_id: c.conv, status: "failed", end_reason: "audio_sequence_incomplete", current_node_key: "vp", vars: {} }).select("id").single();
      const { data } = await admin.rpc("audio_guide_open_request", { p_account: accountA, p_contact: c.contact, p_conversation: c.conv, p_run: (runRow as { id: string }).id, p_trigger: trigger, p_product_key: product, p_expected_revision: null });
      const requestId = (data as { request_id: string }).request_id;
      sql(`update public.audio_guide_sends set not_before = now() - interval '1 second' where request_id = '${requestId}' and position = 1`);
      return { c, requestId, runId: (runRow as { id: string }).id };
    }

    it("Q21 two resumers at the same moment on real PostgreSQL: each audio exactly once, in order, the recovery noted once", async () => {
      reset();
      const p = await pendingRequest("tres", `wamid.RES2.${run}`);
      const [x, y] = await Promise.all([resumer(), resumer()]);
      expect(meta.calls.map((m) => m.link)).toEqual([url(1), url(2), url(3)]);
      expect(sendsOf(p.c.contact)).toBe("1:sent,2:sent,3:sent");
      expect(requestOf(p.c.contact)).toMatch(/^completed\|/);
      expect(x.completed + y.completed).toBeGreaterThanOrEqual(1);
      expect(q(`select count(*) from public.flow_run_events where flow_run_id = '${p.runId}' and payload->>'reason' = 'audio_sequence_recovered'`)).toEqual(["1"]);
      expect(sql(`select status from public.flow_runs where id = '${p.runId}'`)).toBe("failed");
    }, 120_000);

    it("Q22 transient database errors while claiming change nothing; the next resumer completes the sequence", async () => {
      reset();
      const p = await pendingRequest("uno", `wamid.TRANS.${run}`);
      const adminClient = supabaseAdmin();
      const realRpc = adminClient.rpc.bind(adminClient);
      let failures = 2;
      (adminClient as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) => (fn === "audio_guide_claim_next_send" && failures-- > 0 ? Promise.resolve({ data: null, error: { message: "connection reset by peer" } }) : realRpc(fn, args as never));
      try {
        const first = await resumeAudioRequests({ db: adminClient as unknown as SequencerDb, isEnabled: (a) => a === accountA, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
        expect(first.incomplete).toBeGreaterThanOrEqual(1);
        expect(meta.calls).toHaveLength(0);
        expect(sendsOf(p.c.contact)).toBe("1:pending");
        const second = await resumeAudioRequests({ db: adminClient as unknown as SequencerDb, isEnabled: (a) => a === accountA, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
        void second;
        for (let i = 0; i < 3 && meta.calls.length < 1; i++) await resumer();
        expect(meta.calls).toHaveLength(1);
        expect(sendsOf(p.c.contact)).toBe("1:sent");
      } finally { (adminClient as unknown as { rpc: unknown }).rpc = realRpc; }
    }, 60_000);

    it("Q23 a permanent Meta failure closes the request as failed, never retries, and is noted on the run", async () => {
      reset();
      meta.behave = async () => { throw new MetaApiError({ message: "Re-engagement message", code: 131047, httpStatus: 400 }); };
      const p = await pendingRequest("tres", `wamid.PERM.${run}`);
      await resumer();
      await resumer();
      expect(meta.calls).toHaveLength(1);
      expect(sendsOf(p.c.contact)).toBe("1:failed,2:skipped,3:skipped");
      expect(requestOf(p.c.contact)).toMatch(/^failed\|/);
      expect(q(`select payload->>'reason' || '|' || (payload->>'request_status') from public.flow_run_events where flow_run_id = '${p.runId}' and payload->>'phase' = 'recovery'`)).toEqual(["audio_sequence_closed|failed"]);
    }, 60_000);

    it("Q24 a contact blocked and an agent message after the run ended stop the resumer without sending", async () => {
      reset();
      const blocked = await pendingRequest("tres", `wamid.BLK.${run}`);
      sql(`update public.contacts set blocked = true where id = '${blocked.c.contact}'`);
      const agent = await pendingRequest("tres", `wamid.AGT.${run}`);
      sql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) values ('${agent.c.conv}', 'agent', 'text', 'hola', 'wamid.AG.${run}', 'sent', now() + interval '1 second')`);
      await resumer();
      expect(meta.calls).toHaveLength(0);
      expect(sendsOf(blocked.c.contact)).toBe("1:skipped,2:skipped,3:skipped");
      expect(sendsOf(agent.c.contact)).toBe("1:skipped,2:skipped,3:skipped");
      expect(requestOf(blocked.c.contact)).toMatch(/^failed\|contact_blocked\|/);
      expect(requestOf(agent.c.contact)).toMatch(/^failed\|human_takeover\|/);
    }, 60_000);

    it("Q25 the endpoint on real data: GET refused, wrong/short/URL secrets refused, POST resumes under the header secret, health reports and degrades", async () => {
      reset();
      process.env.AUTOMATION_CRON_SECRET = SECRET;
      const route = await import("@/app/api/audio-guide/cron/route");
      const health = await import("@/app/api/audio-guide/health/route");
      const post = (headers: Record<string, string> = {}, url = "http://x/api/audio-guide/cron") => route.POST(new Request(url, { method: "POST", headers }));
      expect(route.GET().status).toBe(405);
      expect((await post()).status).toBe(401);
      expect((await post({ "x-cron-secret": SECRET + "x" })).status).toBe(401);
      expect((await post({ "x-cron-secret": SECRET }, `http://x/api/audio-guide/cron?secret=${SECRET}`)).status).toBe(400);
      expect(meta.calls).toHaveLength(0);
      const p = await pendingRequest("uno", `wamid.EP.${run}`);
      const ok = await post({ "x-cron-secret": SECRET });
      const body = await ok.json();
      expect(ok.status).toBe(200);
      expect(body.examined).toBeGreaterThanOrEqual(1);
      // the endpoint processes only enabled accounts: the enabled account's audio went out
      expect(meta.calls).toHaveLength(1);
      expect(sendsOf(p.c.contact)).toBe("1:sent");
      // health: nothing stuck now
      const h1 = await health.GET(new Request("http://x/api/audio-guide/health", { headers: { "x-cron-secret": SECRET } }));
      expect([200, 503]).toContain(h1.status);
      // a request left in flight for 11 minutes degrades it, a monitor sees a 503
      const stuck = await pendingRequest("tres", `wamid.STUCK.${run}`);
      sql(`update public.audio_guide_requests set created_at = now() - interval '11 minutes' where id = '${stuck.requestId}'`);
      sql(`update public.audio_guide_sends set not_before = now() - interval '6 minutes' where request_id = '${stuck.requestId}' and position = 1`);
      const h2 = await health.GET(new Request("http://x/api/audio-guide/health", { headers: { "x-cron-secret": SECRET } }));
      expect(h2.status).toBe(503);
      const detail = await readAudioGuideHealth(admin as unknown as SequencerDb);
      expect(detail.status).toBe("degraded");
      expect(detail.checks.stuckRequests).toBeGreaterThanOrEqual(1);
      expect(detail.checks.dueBacklog).toBeGreaterThanOrEqual(1);
      await admin.rpc("audio_guide_halt_request", { p_account: accountA, p_request: stuck.requestId, p_reason: "qa_cleanup" });
      delete process.env.AUTOMATION_CRON_SECRET;
    }, 90_000);

    it("Q26 what the operator sees: recent requests with each audio's state and the originating run, only for the account", async () => {
      const list = await listRecentRequests(admin as never, accountA, 50);
      expect(list).not.toBeNull();
      expect(list!.length).toBeGreaterThan(5);
      const statuses = new Set(list!.map((r) => r.status));
      for (const st of ["completed", "failed", "skipped"]) expect(statuses.has(st)).toBe(true);
      expect(list!.some((r) => r.run?.status === "failed" && r.status === "completed")).toBe(true); // recovered later, run still failed
      expect((await listRecentRequests(admin as never, accountB, 50))!.length).toBe(0);
    });
  });
});
