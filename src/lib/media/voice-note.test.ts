import { describe, expect, it } from "vitest";

import {
  VOICE_NOTE_MAX_BYTES,
  baseContentType,
  inspectVoiceNote,
  isOggFamilyContentType,
  sha256Hex,
} from "./voice-note";
import { buildOggOpus, buildPage, concat } from "./test-support/ogg-fixture";

describe("inspectVoiceNote", () => {
  it("accepts a well-formed mono Ogg/Opus file and reports its duration", () => {
    const result = inspectVoiceNote(buildOggOpus());
    expect(result).toMatchObject({ ok: true, channels: 1, pages: 4, preSkip: 312 });
    if (result.ok) expect(result.durationMs).toBe(2000);
  });

  it("rejects stereo Opus (Meta renders voice notes from mono only)", () => {
    expect(inspectVoiceNote(buildOggOpus({ channels: 2 }))).toEqual({ ok: false, reason: "not_mono", channels: 2 });
  });

  it("rejects a zero-channel header and a non-zero mapping family", () => {
    expect(inspectVoiceNote(buildOggOpus({ channels: 0 }))).toMatchObject({ ok: false, reason: "bad_channel_mapping" });
    expect(inspectVoiceNote(buildOggOpus({ family: 1 }))).toMatchObject({ ok: false, reason: "bad_channel_mapping" });
  });

  it("rejects an unsupported Opus header version", () => {
    expect(inspectVoiceNote(buildOggOpus({ version: 0x20 }))).toMatchObject({ ok: false, reason: "opus_version_unsupported" });
  });

  it("rejects empty input and anything that is not an Ogg container", () => {
    expect(inspectVoiceNote(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
    expect(inspectVoiceNote(new TextEncoder().encode("ID3\u0004 not really an mp3"))).toEqual({ ok: false, reason: "not_ogg" });
    expect(inspectVoiceNote(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]))).toEqual({ ok: false, reason: "not_ogg" });
  });

  it("rejects an Ogg stream that is not Opus (Vorbis identification header, valid CRC)", () => {
    const vorbisHead = new Uint8Array(30);
    vorbisHead.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 0);
    const file = concat(
      buildPage({ flags: 0x02, granule: 0, serial: 1, sequence: 0, packets: [vorbisHead] }),
      buildPage({ flags: 0x04, granule: 4800, serial: 1, sequence: 1, packets: [new Uint8Array(20)] }),
    );
    expect(inspectVoiceNote(file)).toEqual({ ok: false, reason: "not_opus" });
  });

  it("rejects a truncated upload", () => {
    const real = buildOggOpus();
    expect(inspectVoiceNote(real.slice(0, real.length - 10))).toMatchObject({ ok: false, reason: "truncated" });
    expect(inspectVoiceNote(real.slice(0, 20))).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("rejects a file whose last page is missing (no end-of-stream flag)", () => {
    expect(inspectVoiceNote(buildOggOpus({ omitEos: true }))).toEqual({ ok: false, reason: "missing_end_of_stream" });
  });

  it("rejects corruption inside any page through the page CRC", () => {
    for (let page = 0; page < 4; page++) {
      expect(inspectVoiceNote(buildOggOpus({ badCrcOnPage: page }))).toEqual({ ok: false, reason: "crc_mismatch" });
    }
    const flipped = buildOggOpus();
    flipped[flipped.length - 5] ^= 0xff;
    expect(inspectVoiceNote(flipped)).toEqual({ ok: false, reason: "crc_mismatch" });
  });

  it("rejects a second page that does not start with OpusTags", () => {
    expect(inspectVoiceNote(buildOggOpus({ omitTags: true }))).toEqual({ ok: false, reason: "missing_opus_tags" });
  });

  it("rejects bytes after the end of the stream (appended data or a chained stream)", () => {
    const real = buildOggOpus();
    expect(inspectVoiceNote(concat(real, new Uint8Array([0, 0, 0, 0])))).toEqual({ ok: false, reason: "trailing_data" });
    expect(inspectVoiceNote(concat(real, buildOggOpus({ serial: 7 })))).toEqual({ ok: false, reason: "trailing_data" });
  });

  it("rejects a stream with no audio after the headers", () => {
    expect(inspectVoiceNote(buildOggOpus({ audioPages: 0 })).ok).toBe(false);
    expect(inspectVoiceNote(buildOggOpus({ finalGranule: 100 }))).toEqual({ ok: false, reason: "no_audio" });
  });

  it("enforces Meta's 16 MB cap", () => {
    expect(inspectVoiceNote(new Uint8Array(VOICE_NOTE_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("never throws on garbage", () => {
    const noise = new Uint8Array(512);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 7) & 0xff;
    expect(() => inspectVoiceNote(noise)).not.toThrow();
    noise.set([0x4f, 0x67, 0x67, 0x53], 0);
    expect(() => inspectVoiceNote(noise)).not.toThrow();
  });
});

describe("content type helpers", () => {
  it("strips parameters and case", () => {
    expect(baseContentType("Audio/OGG; codecs=opus")).toBe("audio/ogg");
    expect(baseContentType(undefined)).toBe("");
  });

  it("accepts every declaration an Opus-in-Ogg file is reported with, and refuses other formats", () => {
    for (const ok of ["", "audio/ogg", "audio/ogg; codecs=opus", "audio/opus", "application/ogg"]) {
      expect(isOggFamilyContentType(ok)).toBe(true);
    }
    for (const bad of ["audio/mpeg", "audio/mp4", "video/ogg", "application/pdf", "text/plain"]) {
      expect(isOggFamilyContentType(bad)).toBe(false);
    }
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
