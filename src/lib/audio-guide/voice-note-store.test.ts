import { describe, expect, it, vi } from "vitest";

import { promoteVoiceNote, type VoiceNoteStorageClient } from "./voice-note-store";
import { buildOggOpus } from "@/lib/media/test-support/ogg-fixture";
import { sha256Hex } from "@/lib/media/voice-note";

const ACCOUNT = "046ff8c2-1111-4222-8333-444455556666";
const OTHER = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const STAGED = `account-${ACCOUNT}/voice-staging/1700000000000-guia.ogg`;

function fakeStorage(files: Record<string, Uint8Array>, opts: { uploadError?: { message: string; statusCode?: string } } = {}) {
  const calls = { download: [] as string[], upload: [] as Array<{ bucket: string; path: string; bytes: Uint8Array; options: unknown }>, remove: [] as string[][] };
  const client: VoiceNoteStorageClient = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          calls.download.push(`${bucket}/${path}`);
          const f = files[`${bucket}/${path}`];
          return f ? { data: new Blob([f.slice().buffer as ArrayBuffer]), error: null } : { data: null, error: { message: "not found" } };
        },
        upload: async (path: string, bytes: Uint8Array, options: unknown) => {
          calls.upload.push({ bucket, path, bytes, options });
          return { error: opts.uploadError ?? null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://s.test/storage/v1/object/public/${bucket}/${path}` } }),
        remove: async (paths: string[]) => {
          calls.remove.push(paths);
          return { error: null };
        },
      }),
    },
  };
  return { client, calls };
}

describe("promoteVoiceNote", () => {
  it("stores the VERIFIED bytes under a content-addressed account path, without overwriting", async () => {
    const file = buildOggOpus();
    const { client, calls } = fakeStorage({ [`chat-media/${STAGED}`]: file });
    const result = await promoteVoiceNote({ admin: client, accountId: ACCOUNT, stagingPath: STAGED });
    const sha = await sha256Hex(file);
    expect(result).toMatchObject({ ok: true, sha256: sha, bytes: file.length, durationMs: 2000, objectPath: `account-${ACCOUNT}/${sha}.ogg` });
    if (result.ok) expect(result.url).toBe(`https://s.test/storage/v1/object/public/voice-notes/account-${ACCOUNT}/${sha}.ogg`);
    expect(calls.upload).toHaveLength(1);
    expect(calls.upload[0].bucket).toBe("voice-notes");
    expect(calls.upload[0].options).toMatchObject({ contentType: "audio/ogg", upsert: false });
    expect(Array.from(calls.upload[0].bytes)).toEqual(Array.from(file));
    expect(calls.remove).toEqual([[STAGED]]);
  });

  it("treats an already-stored identical object as success (idempotent)", async () => {
    const { client } = fakeStorage({ [`chat-media/${STAGED}`]: buildOggOpus() }, { uploadError: { message: "The resource already exists", statusCode: "409" } });
    expect((await promoteVoiceNote({ admin: client, accountId: ACCOUNT, stagingPath: STAGED })).ok).toBe(true);
  });

  it("rejects stereo, corrupt and renamed files and stores nothing", async () => {
    const stereo = buildOggOpus({ channels: 2 });
    const corrupt = buildOggOpus({ badCrcOnPage: 2 });
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
    for (const [bytes, reason] of [[stereo, "not_mono"], [corrupt, "crc_mismatch"], [mp3, "not_ogg"]] as const) {
      const { client, calls } = fakeStorage({ [`chat-media/${STAGED}`]: bytes });
      expect(await promoteVoiceNote({ admin: client, accountId: ACCOUNT, stagingPath: STAGED })).toEqual({ ok: false, code: "rejected", reason });
      expect(calls.upload).toHaveLength(0);
      expect(calls.remove).toHaveLength(0);
    }
  });

  it("rejects an object over 16 MB without reading it", async () => {
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    const { client, calls } = fakeStorage({ [`chat-media/${STAGED}`]: big });
    expect(await promoteVoiceNote({ admin: client, accountId: ACCOUNT, stagingPath: STAGED })).toEqual({ ok: false, code: "rejected", reason: "too_large" });
    expect(calls.upload).toHaveLength(0);
  });

  it("never touches storage for another account's path or a traversal attempt", async () => {
    const spy = vi.fn();
    const { client, calls } = fakeStorage({});
    const guarded: VoiceNoteStorageClient = { storage: { from: (b) => { spy(b); return client.storage.from(b); } } };
    for (const path of [`account-${OTHER}/voice-staging/x.ogg`, `account-${ACCOUNT}/../account-${OTHER}/voice-staging/x.ogg`, `account-${ACCOUNT}/1700000000000-inbox-memo.ogg`, "x.ogg", undefined, 7]) {
      expect(await promoteVoiceNote({ admin: guarded, accountId: ACCOUNT, stagingPath: path })).toEqual({ ok: false, code: "invalid_path" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(calls.download).toHaveLength(0);
  });

  it("reports a missing staged file and a storage failure distinctly", async () => {
    const missing = fakeStorage({});
    expect(await promoteVoiceNote({ admin: missing.client, accountId: ACCOUNT, stagingPath: STAGED })).toEqual({ ok: false, code: "not_found" });
    const failing = fakeStorage({ [`chat-media/${STAGED}`]: buildOggOpus() }, { uploadError: { message: "boom", statusCode: "500" } });
    expect(await promoteVoiceNote({ admin: failing.client, accountId: ACCOUNT, stagingPath: STAGED })).toEqual({ ok: false, code: "storage_error" });
    expect(failing.calls.remove).toHaveLength(0);
  });
});
