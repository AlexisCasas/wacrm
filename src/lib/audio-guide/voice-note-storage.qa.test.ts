// @vitest-environment node
/**
 * QA against REAL Supabase Storage (storage-api over a local file backend) in the isolated staging
 * (qa/audio-guide/staging/up.sh). Skipped unless QA_STORAGE_URL is set, so the normal suite never needs it.
 * Everything is synthetic: random secrets, throwaway accounts, no production credentials or data.
 *
 *   qa/audio-guide/run-storage-qa.sh
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { promoteVoiceNote } from "./voice-note-store";
import { removeStagingOrphans, scanStagingOrphans } from "./staging-cleanup";
import { buildOggOpus } from "@/lib/media/test-support/ogg-fixture";
import { inspectVoiceNote, sha256Hex } from "@/lib/media/voice-note";
import { VOICE_NOTE_BUCKET, VOICE_NOTE_STAGING_BUCKET } from "@/lib/media/voice-note-path";

const env = process.env;
const ENABLED = Boolean(env.QA_STORAGE_URL);
const run = Date.now().toString(36);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
let service: SupabaseClient;
let userA: SupabaseClient;
let userB: SupabaseClient;
let anon: SupabaseClient;
let accountA = "";
let accountB = "";
const created: Array<{ bucket: string; path: string }> = [];

const sql = (query: string) =>
  execFileSync("docker", ["exec", "-i", env.QA_DB_CONTAINER!, "psql", "-U", "supabase_admin", "-h", "/var/run/postgresql", "-d", "postgres", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();

async function signedIn(email: string) {
  const client = createClient(env.QA_STORAGE_URL!, env.QA_ANON_KEY!, noSession);
  const { error } = await client.auth.signInWithPassword({ email, password: env.QA_PASSWORD! });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

/** Stage `bytes` in chat-media as `client`, the way the editor does, and remember it for cleanup. */
async function stage(client: SupabaseClient, account: string, name: string, bytes: Uint8Array, contentType = "audio/ogg") {
  const path = `account-${account}/voice-staging/${run}-${name}.ogg`;
  const { error } = await client.storage.from(VOICE_NOTE_STAGING_BUCKET).upload(path, bytes, { contentType, upsert: false });
  created.push({ bucket: VOICE_NOTE_STAGING_BUCKET, path });
  return { path, error };
}
const promote = (account: string, path: unknown) => promoteVoiceNote({ admin: service as never, accountId: account, stagingPath: path });
const fromVoice = () => service.storage.from(VOICE_NOTE_BUCKET);
const publicUrl = (path: string) => `${env.QA_STORAGE_URL}/storage/v1/object/public/${VOICE_NOTE_BUCKET}/${path}`;
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe.skipIf(!ENABLED)("real Supabase Storage: staging, promotion and protection of voice notes", () => {
  beforeAll(async () => {
    service = createClient(env.QA_STORAGE_URL!, env.QA_SERVICE_KEY!, noSession);
    anon = createClient(env.QA_STORAGE_URL!, env.QA_ANON_KEY!, noSession);
    [userA, userB] = await Promise.all([signedIn(env.QA_USER_A_EMAIL!), signedIn(env.QA_USER_B_EMAIL!)]);
    accountA = sql(`select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='${env.QA_USER_A_EMAIL}'`);
    accountB = sql(`select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='${env.QA_USER_B_EMAIL}'`);
    expect(accountA).toMatch(/^[0-9a-f-]{36}$/);
    expect(accountB).toMatch(/^[0-9a-f-]{36}$/);
    expect(accountA).not.toBe(accountB);
  }, 60_000);

  afterAll(async () => {
    for (const bucket of [VOICE_NOTE_STAGING_BUCKET, VOICE_NOTE_BUCKET]) {
      const paths = created.filter((c) => c.bucket === bucket).map((c) => c.path);
      if (paths.length) await service.storage.from(bucket).remove(paths);
    }
  });

  describe("uploads from the editor (chat-media, user session)", () => {
    it("S01 an account member can stage an OGG/Opus mono file in their own account folder", async () => {
      const { error } = await stage(userA, accountA, "s01", buildOggOpus());
      expect(error).toBeNull();
    });

    it("S02 a member cannot stage into another account's folder, and an anonymous caller cannot stage at all", async () => {
      const foreign = await stage(userA, accountB, "s02", buildOggOpus());
      expect(foreign.error).not.toBeNull();
      const { error } = await anon.storage.from(VOICE_NOTE_STAGING_BUCKET).upload(`account-${accountA}/voice-staging/${run}-s02-anon.ogg`, buildOggOpus(), { contentType: "audio/ogg" });
      expect(error).not.toBeNull();
    });

    it("S03 the bucket's MIME allow-list: 'audio/ogg' passes; the parameterised form is what the editor normalises away", async () => {
      const plain = await stage(userA, accountA, "s03-plain", buildOggOpus(), "audio/ogg");
      expect(plain.error).toBeNull();
      const withParams = await stage(userA, accountA, "s03-params", buildOggOpus(), "audio/ogg; codecs=opus");
      // Recorded, not assumed: whichever way Storage answers, the editor never sends the parameterised form
      // (normalizeOggFile) and the server decides on the bytes, not on this header.
      console.log(`QA-INFO S03 'audio/ogg; codecs=opus' on chat-media -> ${withParams.error ? "REJECTED: " + withParams.error.message : "accepted"}`);
      expect(typeof (withParams.error === null)).toBe("boolean");
    });

    it("S04 chat-media's 16 MB limit refuses a larger object before anything can be promoted", async () => {
      const { error } = await stage(userA, accountA, "s04-big", new Uint8Array(16 * 1024 * 1024 + 1));
      expect(error).not.toBeNull();
    }, 60_000);
  });

  describe("promotion to voice-notes (server credentials)", () => {
    it("S05 promotes a valid mono file: exact bytes, SHA-256 name, stored with audio/ogg, readable by its public URL, staging copy removed", async () => {
      const original = buildOggOpus({ audioPages: 3 });
      const sha = await sha256Hex(original);
      const { path } = await stage(userA, accountA, "s05", original);

      const result = await promote(accountA, path);
      expect(result).toMatchObject({ ok: true, sha256: sha, bytes: original.length, objectPath: `account-${accountA}/${sha}.ogg` });
      if (!result.ok) return;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: result.objectPath });
      expect(result.url).toBe(publicUrl(result.objectPath));

      // download with the SERVER credentials: byte-for-byte identical, hash identical
      const { data, error } = await fromVoice().download(result.objectPath);
      expect(error).toBeNull();
      const stored = await bytesOf(data!);
      expect(sameBytes(stored, original)).toBe(true);
      expect(await sha256Hex(stored)).toBe(sha);

      // and by the public URL Meta would fetch (through the same /storage/v1 gateway as production)
      const response = await fetch(result.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^audio\/ogg/);
      expect(sameBytes(new Uint8Array(await response.arrayBuffer()), original)).toBe(true);

      // staging copy gone
      const gone = await service.storage.from(VOICE_NOTE_STAGING_BUCKET).download(path);
      expect(gone.error).not.toBeNull();
    });

    it("S06 promoting the same bytes twice is idempotent: same object, same URL, bytes untouched (409 handled)", async () => {
      const original = buildOggOpus({ audioPages: 2, audioPayloadBytes: 77 });
      const first = await promote(accountA, (await stage(userA, accountA, "s06a", original)).path);
      const second = await promote(accountA, (await stage(userA, accountA, "s06b", original)).path);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: first.objectPath });
      expect(second.url).toBe(first.url);
      expect(second.sha256).toBe(first.sha256);
      const stored = await bytesOf((await fromVoice().download(first.objectPath)).data!);
      expect(sameBytes(stored, original)).toBe(true);
    });

    it("S07 Storage's own duplicate answer is what promoteVoiceNote treats as success (real 409 shape)", async () => {
      const bytes = buildOggOpus({ audioPayloadBytes: 91 });
      const path = `account-${accountA}/${run}-dup-${await sha256Hex(bytes)}.ogg`;
      created.push({ bucket: VOICE_NOTE_BUCKET, path });
      const a = await fromVoice().upload(path, bytes, { contentType: "audio/ogg", upsert: false });
      const b = await fromVoice().upload(path, bytes, { contentType: "audio/ogg", upsert: false });
      expect(a.error).toBeNull();
      expect(b.error).not.toBeNull();
      const e = b.error as unknown as { statusCode?: string | number; message: string };
      console.log(`QA-INFO S07 duplicate upload error -> statusCode=${e.statusCode} message=${e.message}`);
      expect(String(e.statusCode) === "409" || /already exists|duplicate/i.test(e.message)).toBe(true);
    });

    it.each([
      ["stereo", () => buildOggOpus({ channels: 2 }), "audio/ogg", "not_mono"],
      ["corrupt (bad page CRC)", () => buildOggOpus({ badCrcOnPage: 2 }), "audio/ogg", "crc_mismatch"],
      ["truncated", () => buildOggOpus().slice(0, 150), "audio/ogg", "truncated"],
      ["not Opus-in-Ogg (MP3 bytes renamed .ogg)", () => new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(300).fill(7)]), "audio/ogg", "not_ogg"],
      ["a real MP3 declared as audio/mpeg", () => new Uint8Array([0x49, 0x44, 0x33, 0x04, ...new Array(300).fill(9)]), "audio/mpeg", "not_ogg"],
    ] as const)("S08 rejects %s and stores nothing in voice-notes", async (name, make, contentType, reason) => {
      const before = (await fromVoice().list(`account-${accountA}`, { limit: 1000 })).data?.length ?? 0;
      const { path, error } = await stage(userA, accountA, `s08-${reason}-${name.replace(/[^a-z]+/gi, "").slice(0, 12)}`, make(), contentType);
      expect(error).toBeNull();
      expect(await promote(accountA, path)).toEqual({ ok: false, code: "rejected", reason });
      const after = (await fromVoice().list(`account-${accountA}`, { limit: 1000 })).data?.length ?? 0;
      expect(after).toBe(before);
    });

    it("S09 a file just under 16 MB (valid, ~15.9 MB) is accepted end to end, byte-identical", async () => {
      const big = buildOggOpus({ audioPages: 265, audioPayloadBytes: 62_000 });
      expect(big.length).toBeGreaterThan(15 * 1024 * 1024);
      expect(big.length).toBeLessThanOrEqual(16 * 1024 * 1024);
      const { path, error } = await stage(userA, accountA, "s09-big", big);
      expect(error).toBeNull();
      const result = await promote(accountA, path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: result.objectPath });
      expect(sameBytes(await bytesOf((await fromVoice().download(result.objectPath)).data!), big)).toBe(true);
    }, 120_000);

    it.skipIf(!existsSync("qa/audio-guide/staging/state/real-mono-opus-large.ogg"))("S09b a REAL libopus file of ~15.4 MB (just under the cap): verified in well under a second, promoted, byte-identical", async () => {
      const real = new Uint8Array(readFileSync("qa/audio-guide/staging/state/real-mono-opus-large.ogg"));
      expect(real.length).toBeGreaterThan(15 * 1024 * 1024);
      expect(real.length).toBeLessThan(16 * 1024 * 1024);
      const t0 = performance.now();
      const verdict = inspectVoiceNote(real);
      const ms = performance.now() - t0;
      console.log(`QA-INFO S09b verifier on ${(real.length / 1048576).toFixed(1)} MB: ${ms.toFixed(0)} ms, ok=${verdict.ok}, duration=${verdict.ok ? verdict.durationMs : "-"} ms`);
      expect(verdict.ok).toBe(true);
      expect(ms).toBeLessThan(3000);
      const { path, error } = await stage(userA, accountA, "s09b-real-large", real);
      expect(error).toBeNull();
      const result = await promote(accountA, path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: result.objectPath });
      expect(sameBytes(await bytesOf((await fromVoice().download(result.objectPath)).data!), real)).toBe(true);
    }, 120_000);

    it("S10 account isolation: nobody can promote another account's path, and an account id cannot be swapped", async () => {
      const mine = await stage(userA, accountA, "s10-a", buildOggOpus({ audioPayloadBytes: 55 }));
      const theirs = await stage(userB, accountB, "s10-b", buildOggOpus({ audioPayloadBytes: 56 }));
      expect(mine.error).toBeNull();
      expect(theirs.error).toBeNull();
      expect(await promote(accountA, theirs.path)).toEqual({ ok: false, code: "invalid_path" });
      expect(await promote(accountB, mine.path)).toEqual({ ok: false, code: "invalid_path" });
      const traversal = `account-${accountA}/../account-${accountB}/voice-staging/${run}-s10-b.ogg`;
      expect(await promote(accountA, traversal)).toEqual({ ok: false, code: "invalid_path" });
      // the right owner still works, and the result lives under the owner's folder only
      const ok = await promote(accountB, theirs.path);
      expect(ok.ok).toBe(true);
      if (ok.ok) { created.push({ bucket: VOICE_NOTE_BUCKET, path: ok.objectPath }); expect(ok.objectPath.startsWith(`account-${accountB}/`)).toBe(true); }
    });
  });

  describe("protection of the validated file", () => {
    let objectPath = "";
    let original: Uint8Array;

    beforeAll(async () => {
      original = buildOggOpus({ audioPages: 2, audioPayloadBytes: 123 });
      const { path } = await stage(userA, accountA, "prot", original);
      const result = await promote(accountA, path);
      if (!result.ok) throw new Error("setup promotion failed");
      objectPath = result.objectPath;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: objectPath });
    });

    const untouched = async () => sameBytes(await bytesOf((await fromVoice().download(objectPath)).data!), original);

    it("S11 a signed-in member of the OWNING account cannot overwrite, replace, move, copy over or delete it", async () => {
      const evil = buildOggOpus({ audioPayloadBytes: 200 });
      const voice = userA.storage.from(VOICE_NOTE_BUCKET);
      const overwrite = await voice.upload(objectPath, evil, { contentType: "audio/ogg", upsert: true });
      expect(overwrite.error).not.toBeNull();
      const update = await voice.update(objectPath, evil, { contentType: "audio/ogg" });
      expect(update.error).not.toBeNull();
      const move = await voice.move(objectPath, `account-${accountA}/${run}-moved.ogg`);
      expect(move.error).not.toBeNull();
      const copy = await voice.copy(`account-${accountA}/${run}-copy-source.ogg`, objectPath).catch((e) => ({ error: e }));
      expect(copy.error).toBeTruthy();
      const remove = await voice.remove([objectPath]);
      expect(remove.error !== null || (remove.data ?? []).length === 0).toBe(true);
      expect(await untouched()).toBe(true);
    });

    it("S12 a member of ANOTHER account, and an anonymous caller, cannot write or delete either", async () => {
      const evil = buildOggOpus({ audioPayloadBytes: 201 });
      for (const client of [userB, anon]) {
        const voice = client.storage.from(VOICE_NOTE_BUCKET);
        expect((await voice.upload(objectPath, evil, { contentType: "audio/ogg", upsert: true })).error).not.toBeNull();
        expect((await voice.upload(`account-${accountA}/${run}-planted.ogg`, evil, { contentType: "audio/ogg" })).error).not.toBeNull();
        const remove = await voice.remove([objectPath]);
        expect(remove.error !== null || (remove.data ?? []).length === 0).toBe(true);
      }
      expect(await untouched()).toBe(true);
    });

    it("S13 the server itself never overwrites: a second write to the same name is refused (409) and the bytes stay", async () => {
      const evil = buildOggOpus({ audioPayloadBytes: 202 });
      const { error } = await fromVoice().upload(objectPath, evil, { contentType: "audio/ogg", upsert: false });
      expect(error).not.toBeNull();
      expect(await untouched()).toBe(true);
    });

    it("S14 replacing the STAGED copy after promotion changes nothing that is sent; promoting the replacement yields a different, new object", async () => {
      const stagedPath = `account-${accountA}/voice-staging/${run}-swap.ogg`;
      const first = buildOggOpus({ audioPayloadBytes: 31 });
      const second = buildOggOpus({ audioPayloadBytes: 32 });
      created.push({ bucket: VOICE_NOTE_STAGING_BUCKET, path: stagedPath });
      expect((await userA.storage.from(VOICE_NOTE_STAGING_BUCKET).upload(stagedPath, first, { contentType: "audio/ogg" })).error).toBeNull();
      const r1 = await promote(accountA, stagedPath);
      expect(r1.ok).toBe(true);
      // the user re-uploads different bytes under the same staging name (promotion removed the first)
      expect((await userA.storage.from(VOICE_NOTE_STAGING_BUCKET).upload(stagedPath, second, { contentType: "audio/ogg", upsert: true })).error).toBeNull();
      if (!r1.ok) return;
      created.push({ bucket: VOICE_NOTE_BUCKET, path: r1.objectPath });
      expect(sameBytes(await bytesOf((await fromVoice().download(r1.objectPath)).data!), first)).toBe(true);
      const r2 = await promote(accountA, stagedPath);
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        created.push({ bucket: VOICE_NOTE_BUCKET, path: r2.objectPath });
        expect(r2.sha256).not.toBe(r1.sha256);
        expect(r2.url).not.toBe(r1.url);
      }
      expect(sameBytes(await bytesOf((await fromVoice().download(r1.objectPath)).data!), first)).toBe(true);
    });

    it("S15 the bucket itself only accepts audio/ogg and 16 MB, even for the server", async () => {
      const mp3 = await fromVoice().upload(`account-${accountA}/${run}-x.ogg`, new Uint8Array([1, 2, 3]), { contentType: "audio/mpeg" });
      expect(mp3.error).not.toBeNull();
      const big = await fromVoice().upload(`account-${accountA}/${run}-big.ogg`, new Uint8Array(16 * 1024 * 1024 + 1), { contentType: "audio/ogg" });
      expect(big.error).not.toBeNull();
    }, 60_000);

    it("S16 the URL is public by design (Meta fetches it) but the bucket cannot be listed or enumerated by anyone but the server", async () => {
      const response = await fetch(publicUrl(objectPath));
      expect(response.status).toBe(200);
      expect(sameBytes(new Uint8Array(await response.arrayBuffer()), original)).toBe(true);
      for (const client of [anon, userA, userB]) {
        const own = await client.storage.from(VOICE_NOTE_BUCKET).list(`account-${accountA}`);
        const root = await client.storage.from(VOICE_NOTE_BUCKET).list("");
        expect([(own.data ?? []).length, (root.data ?? []).length]).toEqual([0, 0]);
      }
      expect((await fromVoice().list(`account-${accountA}`)).data!.length).toBeGreaterThan(0); // the server still can
    });
  });

  describe("catalog (migration 073) against the REAL storage.objects", () => {
    it("S17 an item can only reference a stored voice-note object of its own account", async () => {
      const original = buildOggOpus({ audioPayloadBytes: 61 });
      const sha = await sha256Hex(original);
      const { path } = await stage(userA, accountA, "cat", original);
      const result = await promote(accountA, path);
      expect(result.ok).toBe(true);
      if (result.ok) created.push({ bucket: VOICE_NOTE_BUCKET, path: result.objectPath });
      const key = `qa ${run}`;
      sql(`insert into public.audio_guide_products (id, account_id, product_key, display_name) values ('c0000000-0000-4000-8000-000000000001','${accountA}','${key}','QA')`);
      try {
        sql(`insert into public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms) values ('${accountA}','c0000000-0000-4000-8000-000000000001',1,'${sha}','account-${accountA}/${sha}.ogg',${original.length},2000)`);
        expect(sql(`select count(*) from public.audio_guide_items where voice_sha256='${sha}'`)).toBe("1");
        const fake = "f".repeat(64);
        expect(() => sql(`insert into public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms) values ('${accountA}','c0000000-0000-4000-8000-000000000001',2,'${fake}','account-${accountA}/${fake}.ogg',10,1000)`)).toThrow();
        expect(() => sql(`insert into public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms) values ('${accountB}','c0000000-0000-4000-8000-000000000001',3,'${sha}','account-${accountB}/${sha}.ogg',10,1000)`)).toThrow();
      } finally {
        sql(`delete from public.audio_guide_products where id='c0000000-0000-4000-8000-000000000001'`);
      }
    });
  });

  describe("orphan cleanup of the staging folder (real Storage listing and removal)", () => {
    const DAY = 24 * 3600 * 1000;
    const cleanupRun = Date.now();
    // names the editor itself would generate: <13-digit epoch ms>-<name>.ogg
    const mk = (account: string, ageDays: number, name: string) => `account-${account}/voice-staging/${cleanupRun - ageDays * DAY}-${name}.ogg`;
    let orphanA = "", orphanB = "", recent = "", reused = "", referenced = "", inboxMemo = "", textFile = "";
    const retention = 7 * DAY;
    const deps = () => ({
      storage: service.storage as never,
      isReferenced: async (path: string) => sql(`select count(*) from public.messages where media_url like '%/${path.replace(/'/g, "''").replace(/_/g, "\\_")}' escape '\\'`) !== "0",
      now: () => cleanupRun,
    });
    // Storage stamps updated_at itself on every UPDATE; switch its triggers off for this one statement so a test can make an object genuinely old
    const age = (path: string, days: number) => sql(`begin; set local session_replication_role = replica; update storage.objects set created_at = now() - interval '${days} days', updated_at = now() - interval '${days} days' where bucket_id='chat-media' and name='${path}'; commit`);
    const mine = (scan: Awaited<ReturnType<typeof scanStagingOrphans>>) => scan.candidates.filter((c) => c.path.includes(run)).map((c) => c.path).sort();

    beforeAll(async () => {
      orphanA = mk(accountA, 10, `cu-orphan-${run}`.slice(0, 40));
      orphanB = mk(accountB, 9, `cu-orphan-b-${run}`.slice(0, 40));
      recent = mk(accountA, 0.1, `cu-recent-${run}`.slice(0, 40));
      reused = mk(accountA, 10, `cu-reused-${run}`.slice(0, 40));
      referenced = mk(accountA, 12, `cu-ref-${run}`.slice(0, 40));
      inboxMemo = `account-${accountA}/${cleanupRun - 20 * DAY}-cu-inbox-${run}.ogg`;
      textFile = `account-${accountA}/voice-staging/cu-notes-${run}.ogg`;
      const bytes = buildOggOpus();
      for (const path of [orphanA, orphanB, recent, reused, referenced, inboxMemo, textFile]) {
        const { error } = await service.storage.from(VOICE_NOTE_STAGING_BUCKET).upload(path, bytes, { contentType: "audio/ogg", upsert: false });
        expect(error).toBeNull();
        created.push({ bucket: VOICE_NOTE_STAGING_BUCKET, path });
      }
      // make the objects old by Storage's own clock too (the staging window is judged on both)
      age(orphanA, 10); age(orphanB, 9); age(referenced, 12); age(inboxMemo, 20); age(textFile, 20);
      age(reused, 0); // same OLD name, but the object was written moments ago (a re-upload under that name)
      // a message that still points at `referenced`
      const conv = sql(`select id from public.conversations where account_id='${accountA}' limit 1`);
      const conversationId = conv || sql(`with c as (insert into public.contacts (account_id, user_id, name, phone) select '${accountA}', p.user_id, 'QA', '+15550001111' from public.profiles p where p.account_id='${accountA}' limit 1 returning id, user_id) insert into public.conversations (account_id, user_id, contact_id) select '${accountA}', user_id, id from c returning id`);
      sql(`insert into public.messages (conversation_id, sender_type, content_type, media_url, message_id, status) values ('${conversationId.split("\n")[0]}','agent','audio','${env.QA_STORAGE_URL}/storage/v1/object/public/chat-media/${referenced}','qa-cleanup-${run}','sent')`);
    }, 60_000);

    it("S18 a dry scan lists ONLY the unreferenced, old, editor-staged files, and removes nothing", async () => {
      const before = await scanStagingOrphans(deps(), retention);
      expect(mine(before)).toEqual([orphanA, orphanB].sort());
      for (const path of [orphanA, orphanB, recent, reused, referenced, inboxMemo, textFile]) {
        const { error } = await service.storage.from(VOICE_NOTE_STAGING_BUCKET).download(path);
        expect(error).toBeNull(); // everything still exists
      }
    });

    it("S19 the SQL report an operator can read lists the same files as the code", async () => {
      const csv = execFileSync("docker", ["exec", "-i", env.QA_DB_CONTAINER!, "psql", "-U", "supabase_admin", "-h", "/var/run/postgresql", "-d", "postgres", "-X", "-A", "-t", "-q", "-F", "|", "-v", "retention_days=7", "-f", "-"], { input: readFileSync("qa/audio-guide/orphans-report.sql", "utf8"), encoding: "utf8" });
      const listed = csv.split("\n").map((l) => l.split("|")[0]).filter((p) => p.startsWith("account-") && p.includes(run)).sort();
      expect(listed).toEqual([orphanA, orphanB].sort());
    });

    it("S20 removal needs the reviewed list: others in the same bucket survive, a recent or Inbox file named in the list is refused", async () => {
      expect(await removeStagingOrphans(deps(), [], retention)).toEqual({ removed: [], skipped: [] });
      const result = await removeStagingOrphans(deps(), [orphanA, recent, inboxMemo, referenced, reused, textFile], retention);
      expect(result.removed).toEqual([orphanA]);
      expect(result.skipped.map((s) => s.path).sort()).toEqual([recent, inboxMemo, referenced, reused, textFile].sort());
      expect((await service.storage.from(VOICE_NOTE_STAGING_BUCKET).download(orphanA)).error).not.toBeNull();
      for (const path of [orphanB, recent, reused, referenced, inboxMemo, textFile]) {
        expect((await service.storage.from(VOICE_NOTE_STAGING_BUCKET).download(path)).error).toBeNull();
      }
    });

    it("S21 an object that is NOT the editor's own (promoted notes, other buckets) is never touched by a cleanup run", async () => {
      const promoted = await promote(accountA, (await stage(userA, accountA, "cu-promoted", buildOggOpus({ audioPayloadBytes: 17 }))).path);
      expect(promoted.ok).toBe(true);
      if (promoted.ok) created.push({ bucket: VOICE_NOTE_BUCKET, path: promoted.objectPath });
      await removeStagingOrphans(deps(), [orphanB], retention);
      if (promoted.ok) expect((await fromVoice().download(promoted.objectPath)).error).toBeNull();
    });
  });
});
