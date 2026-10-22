import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const up = vi.hoisted(() => ({ calls: [] as Array<{ bucket: string; file: File; opts: unknown }>, fail: false }));
vi.mock("@/lib/storage/upload-media", () => ({
  uploadAccountMedia: vi.fn(async (bucket: string, file: File, opts: unknown) => {
    if (up.fail) throw new Error("network down");
    up.calls.push({ bucket, file, opts });
    return { publicUrl: "https://cdn.test/x.ogg", path: `account-x/voice-staging/1700000000000-${file.name}` };
  }),
}));

import { VOICE_NOTE_MAX_BYTES, inspectVoiceNote, pageCrc } from "@/lib/media/voice-note";
import { problemOf, stageVoiceNote } from "./stage-client";

describe("problemOf", () => {
  it("turns every verifier rejection into one of the messages a person sees", () => {
    expect(problemOf("not_mono")).toBe("not_mono");
    expect(problemOf("too_large")).toBe("too_large");
    for (const r of ["not_ogg", "not_opus", "opus_version_unsupported", "bad_channel_mapping"] as const) expect(problemOf(r)).toBe("not_ogg");
    for (const r of ["empty", "truncated", "crc_mismatch", "bad_page_structure", "missing_opus_tags", "missing_end_of_stream", "trailing_data", "no_audio"] as const) expect(problemOf(r)).toBe("corrupt");
    expect(problemOf(undefined)).toBe("corrupt");
  });
});

// Real encoder output, as in the Multimedia tests.
const fx = (name: string) => new Uint8Array(readFileSync(join(__dirname, "../media/test-support/fixtures", name)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const asFile = (bytes: Uint8Array, name = "guia.ogg", type = "audio/ogg") => new File([bytes as BlobPart], name, { type });

function pageStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    starts.push(at);
    const segments = bytes[at + 26];
    let data = 0;
    for (let i = 0; i < segments; i++) data += bytes[at + 27 + i];
    at += 27 + segments + data;
  }
  return starts;
}
/** What a recorder that never sets the end-of-stream flag writes. */
function withoutEos(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  const last = pageStarts(copy).at(-1)!;
  copy[last + 5] &= ~0x04;
  let data = 0;
  for (let i = 0; i < copy[last + 26]; i++) data += copy[last + 27 + i];
  new DataView(copy.buffer).setUint32(last + 22, pageCrc(copy, last, 27 + copy[last + 26] + data), true);
  return copy;
}
const uploadedBytes = async () => new Uint8Array(await up.calls[0].file.arrayBuffer());

beforeEach(() => {
  up.calls = [];
  up.fail = false;
});

describe("stageVoiceNote: what reaches the staging folder", () => {
  it("a well-formed file goes up as it is, not flagged as repaired", async () => {
    const original = fx("real-mono-opus.ogg");
    const r = await stageVoiceNote(asFile(original));
    expect(r).toMatchObject({ ok: true, repaired: false, fileName: "guia.ogg" });
    expect(sha(await uploadedBytes())).toBe(sha(original));
    expect(up.calls[0].file.type).toBe("audio/ogg");
  });

  it("a complete stream that only lacks the end-of-stream flag is repaired: the upload is exactly what the encoder wrote, and the person is told", async () => {
    const original = fx("real-mono-opus.ogg");
    const r = await stageVoiceNote(asFile(withoutEos(original)));
    expect(r).toMatchObject({ ok: true, repaired: true });
    if (r.ok) expect(r.durationMs).toBeGreaterThan(2900);
    expect(sha(await uploadedBytes())).toBe(sha(original));
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0].bucket).toBe("chat-media");
  });

  it("the type the browser declares does not matter for a good file (application/ogg and empty are common)", async () => {
    for (const type of ["application/ogg", "", "audio/opus"]) {
      up.calls = [];
      expect(await stageVoiceNote(asFile(fx("real-mono-opus.ogg"), "a.ogg", type))).toMatchObject({ ok: true });
    }
  });

  it("real damage is rejected and NOTHING is uploaded", async () => {
    const damaged = withoutEos(fx("real-mono-opus.ogg"));
    damaged[pageStarts(damaged)[3] + 40] ^= 0xff; // a changed byte inside a page: its CRC no longer matches
    expect(await stageVoiceNote(asFile(damaged))).toEqual({ ok: false, problem: "corrupt" });
    const real = fx("real-mono-opus.ogg");
    expect(await stageVoiceNote(asFile(real.slice(0, real.length - 10)))).toEqual({ ok: false, problem: "corrupt" });
    expect(await stageVoiceNote(asFile(new Uint8Array(0)))).toEqual({ ok: false, problem: "corrupt" });
    expect(up.calls).toHaveLength(0);
  });

  it("incompatible audio is rejected with its own message and nothing is uploaded", async () => {
    expect(await stageVoiceNote(asFile(fx("real-stereo-opus.ogg")))).toEqual({ ok: false, problem: "not_mono" });
    expect(await stageVoiceNote(asFile(withoutEos(fx("real-stereo-opus.ogg"))))).toEqual({ ok: false, problem: "not_mono" });
    expect(await stageVoiceNote(asFile(fx("real-mono-vorbis.ogg")))).toEqual({ ok: false, problem: "not_ogg" });
    expect(await stageVoiceNote(asFile(fx("real-mono.mp3"), "renombrado.ogg"))).toEqual({ ok: false, problem: "not_ogg" });
    expect(up.calls).toHaveLength(0);
  });

  it("the cheap checks still come first: extension, size, plainly foreign declared type", async () => {
    expect(await stageVoiceNote(asFile(fx("real-mono-opus.ogg"), "guia.mp3"))).toEqual({ ok: false, problem: "needs_ogg" });
    expect(await stageVoiceNote(asFile(new Uint8Array(VOICE_NOTE_MAX_BYTES + 1), "grande.ogg"))).toEqual({ ok: false, problem: "too_large" });
    expect(await stageVoiceNote(asFile(fx("real-mono-opus.ogg"), "guia.ogg", "audio/mpeg"))).toEqual({ ok: false, problem: "not_ogg" });
    expect(up.calls).toHaveLength(0);
  });

  it("a failed upload is reported and leaves nothing half-done", async () => {
    up.fail = true;
    expect(await stageVoiceNote(asFile(fx("real-mono-opus.ogg")))).toEqual({ ok: false, problem: "upload_failed" });
  });
});

// The two real files from the pilot QA live outside the repository; point WACRM_QA_MEDIA_DIR at the folder that holds them to run these.
const QA_DIR = process.env.WACRM_QA_MEDIA_DIR ?? "";
const ORIGINAL = join(QA_DIR, "aspiradora-portatil.ogg");
const CORRECTED = join(QA_DIR, "aspiradora-portatil.eos.ogg");
describe.skipIf(!QA_DIR || !existsSync(ORIGINAL) || !existsSync(CORRECTED))("the files from the pilot QA (read from WACRM_QA_MEDIA_DIR, never copied into the repository)", () => {
  it("the original WhatsApp OGG is accepted, repaired, and ends up byte-identical to the corrected file (same hash, so it deduplicates)", async () => {
    const r = await stageVoiceNote(asFile(new Uint8Array(readFileSync(ORIGINAL)), "aspiradora-portatil.ogg"));
    expect(r).toMatchObject({ ok: true, repaired: true, durationMs: 44240 });
    expect(sha(await uploadedBytes())).toBe(sha(new Uint8Array(readFileSync(CORRECTED))));
  });

  it("what is staged passes the SAME strict verifier the server runs, and carries the full duration the player will show (44.24 s, 27 pages)", async () => {
    await stageVoiceNote(asFile(new Uint8Array(readFileSync(ORIGINAL)), "aspiradora-portatil.ogg"));
    expect(inspectVoiceNote(await uploadedBytes())).toMatchObject({ ok: true, channels: 1, durationMs: 44240, pages: 27 });
  });

  it("the corrected file goes up untouched", async () => {
    const r = await stageVoiceNote(asFile(new Uint8Array(readFileSync(CORRECTED)), "aspiradora-portatil.eos.ogg"));
    expect(r).toMatchObject({ ok: true, repaired: false, durationMs: 44240 });
  });
});
