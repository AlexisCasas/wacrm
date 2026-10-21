import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VOICE_NOTE_MAX_BYTES, inspectVoiceNote, pageCrc } from "./voice-note";
import { prepareVoiceNote } from "./voice-note-prepare";

// Real encoder output (libopus/libvorbis/libmp3lame), as in voice-note.real.test.ts.
const fx = (name: string) => new Uint8Array(readFileSync(join(__dirname, "test-support/fixtures", name)));

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

function rewriteCrc(bytes: Uint8Array, start: number) {
  const segments = bytes[start + 26];
  let data = 0;
  for (let i = 0; i < segments; i++) data += bytes[start + 27 + i];
  const crc = pageCrc(bytes, start, 27 + segments + data);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(start + 22, crc, true);
}

/** What a recorder that never sets the end-of-stream flag writes: the same file with that bit cleared (CRC kept valid). */
function withoutEos(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  const last = pageStarts(copy).at(-1)!;
  copy[last + 5] &= ~0x04;
  rewriteCrc(copy, last);
  return copy;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("prepareVoiceNote", () => {
  it("accepts a well-formed file untouched", () => {
    const input = fx("real-mono-opus.ogg");
    const result = prepareVoiceNote(input);
    expect(result).toMatchObject({ ok: true, repaired: false });
    if (result.ok) expect(result.bytes).toBe(input);
  });

  it("repairs a complete stream that only lacks the end-of-stream flag, changing exactly the flag and that page's CRC", () => {
    const original = fx("real-mono-opus.ogg");
    const input = withoutEos(original);
    expect(inspectVoiceNote(input)).toEqual({ ok: false, reason: "missing_end_of_stream" });
    const result = prepareVoiceNote(input);
    expect(result).toMatchObject({ ok: true, repaired: "missing_end_of_stream" });
    if (!result.ok) return;
    expect(inspectVoiceNote(result.bytes).ok).toBe(true);
    expect(sha(result.bytes)).toBe(sha(original)); // byte-identical to what the encoder wrote
    const changed = input.reduce((n, b, i) => n + (b !== result.bytes[i] ? 1 : 0), 0);
    expect(changed).toBeLessThanOrEqual(5);
    expect(result.inspection.durationMs).toBeGreaterThan(2900);
  });

  it("does not modify its input", () => {
    const input = withoutEos(fx("real-mono-opus.ogg"));
    const before = sha(input);
    prepareVoiceNote(input);
    expect(sha(input)).toBe(before);
  });

  it("works on every real mono Opus fixture without the flag", () => {
    for (const name of ["real-mono-opus-4.ogg", "real-mono-opus-5.ogg", "real-mono-opus-6.ogg", "real-mono-opus-7.ogg", "real-mono-opus-b.ogg", "real-mono-opus-c.ogg"]) {
      const original = fx(name);
      if (!inspectVoiceNote(original).ok) continue; // some fixtures are deliberately unusual; the others must round-trip
      const result = prepareVoiceNote(withoutEos(original));
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(sha(result.bytes), name).toBe(sha(original));
    }
  });

  it("never repairs real damage: a changed byte inside a page fails its CRC", () => {
    const input = withoutEos(fx("real-mono-opus.ogg"));
    const middle = pageStarts(input)[3];
    input[middle + 40] ^= 0xff;
    expect(prepareVoiceNote(input)).toEqual({ ok: false, reason: "crc_mismatch" });
  });

  it("never repairs a file cut inside a page, with or without the flag", () => {
    const real = fx("real-mono-opus.ogg");
    expect(prepareVoiceNote(real.slice(0, real.length - 10))).toMatchObject({ ok: false, reason: "truncated" });
    expect(prepareVoiceNote(withoutEos(real).slice(0, real.length - 10))).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("refuses when the last page's granule position disagrees with the packets it holds", () => {
    const input = withoutEos(fx("real-mono-opus.ogg"));
    const last = pageStarts(input).at(-1)!;
    new DataView(input.buffer).setUint32(last + 6, 1, true); // a final position far below what the packets add up to
    new DataView(input.buffer).setUint32(last + 10, 0, true);
    rewriteCrc(input, last);
    expect(prepareVoiceNote(input)).toEqual({ ok: false, reason: "truncated" });
  });

  it("refuses a gap in the page sequence", () => {
    const input = withoutEos(fx("real-mono-opus.ogg"));
    const starts = pageStarts(input);
    const skipped = starts[3];
    new DataView(input.buffer).setUint32(skipped + 18, 99, true);
    rewriteCrc(input, skipped);
    expect(prepareVoiceNote(input)).toMatchObject({ ok: false, reason: "bad_page_structure" });
  });

  it("keeps rejecting what is not a mono Opus voice note", () => {
    expect(prepareVoiceNote(fx("real-stereo-opus.ogg"))).toMatchObject({ ok: false, reason: "not_mono" });
    expect(prepareVoiceNote(withoutEos(fx("real-stereo-opus.ogg")))).toMatchObject({ ok: false, reason: "not_mono" });
    expect(prepareVoiceNote(fx("real-mono-vorbis.ogg"))).toMatchObject({ ok: false, reason: "not_opus" });
    expect(prepareVoiceNote(fx("real-mono.mp3"))).toMatchObject({ ok: false, reason: "not_ogg" });
    expect(prepareVoiceNote(new Uint8Array(0))).toMatchObject({ ok: false, reason: "empty" });
  });

  it("rejects a forged file whose bytes are not Ogg whatever its name or type says", () => {
    expect(prepareVoiceNote(new TextEncoder().encode("MZ\u0090 not audio at all, renamed .ogg"))).toMatchObject({ ok: false, reason: "not_ogg" });
    expect(prepareVoiceNote(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]))).toMatchObject({ ok: false });
  });

  it("rejects a file above the 16 MB limit before looking inside", () => {
    expect(prepareVoiceNote(new Uint8Array(VOICE_NOTE_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("documents the limit: a stream cut exactly at a page boundary cannot be told from one that lacks the flag", () => {
    const real = fx("real-mono-opus.ogg");
    const starts = pageStarts(real);
    const cutAtBoundary = real.slice(0, starts.at(-2)! + 0);
    const lastKept = pageStarts(cutAtBoundary).at(-1)!;
    const stripped = new Uint8Array(cutAtBoundary);
    stripped[lastKept + 5] &= ~0x04;
    rewriteCrc(stripped, lastKept);
    const result = prepareVoiceNote(stripped);
    // It is accepted but flagged as repaired, with the shorter duration, so the editor tells the person to compare it.
    expect(result).toMatchObject({ ok: true, repaired: "missing_end_of_stream" });
    if (result.ok) expect(result.inspection.durationMs).toBeLessThan(inspectVoiceNote(real).ok ? (inspectVoiceNote(real) as { durationMs: number }).durationMs : 0);
  });
});

// The two files from the real QA, read from the VPS media folder when present (outside the repository; never copied into it).
const ORIGINAL = "/opt/wacrm-pilot-media/aspiradora-portatil.ogg";
const CORRECTED = "/opt/wacrm-pilot-media/aspiradora-portatil.eos.ogg";
describe.skipIf(!existsSync(ORIGINAL) || !existsSync(CORRECTED))("the files from the pilot QA", () => {
  it("repairs the original automatically into exactly the corrected file", () => {
    const original = new Uint8Array(readFileSync(ORIGINAL));
    const corrected = new Uint8Array(readFileSync(CORRECTED));
    expect(inspectVoiceNote(original)).toEqual({ ok: false, reason: "missing_end_of_stream" });
    const result = prepareVoiceNote(original);
    expect(result).toMatchObject({ ok: true, repaired: "missing_end_of_stream" });
    if (!result.ok) return;
    expect(sha(result.bytes)).toBe(sha(corrected));
    expect(result.inspection.durationMs).toBe(44240);
  });

  it("takes the corrected file as it is", () => {
    expect(prepareVoiceNote(new Uint8Array(readFileSync(CORRECTED)))).toMatchObject({ ok: true, repaired: false });
  });
});
