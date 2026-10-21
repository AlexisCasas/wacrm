import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectVoiceNote } from "./voice-note";

// REAL encoder output (libopus / libvorbis / libmp3lame through ffmpeg; see qa/audio-guide/make-fixtures.sh), not bytes built by the
// test helpers. This is the check that the verifier agrees with what an actual encoder writes.
const fx = (name: string) => new Uint8Array(readFileSync(join(__dirname, "test-support/fixtures", name)));

describe("inspectVoiceNote on real encoder output", () => {
  it("accepts a mono libopus file and reports a ~3 s duration", () => {
    const result = inspectVoiceNote(fx("real-mono-opus.ogg"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels).toBe(1);
      expect(result.durationMs).toBeGreaterThan(2900);
      expect(result.durationMs).toBeLessThan(3200);
      expect(result.inputSampleRate).toBe(48000);
    }
  });

  it("rejects a stereo libopus file as not mono", () => {
    expect(inspectVoiceNote(fx("real-stereo-opus.ogg"))).toEqual({ ok: false, reason: "not_mono", channels: 2 });
  });

  it("rejects an Ogg/Vorbis file", () => {
    expect(inspectVoiceNote(fx("real-mono-vorbis.ogg"))).toEqual({ ok: false, reason: "not_opus" });
  });

  it("rejects an MP3, with or without an .ogg name", () => {
    expect(inspectVoiceNote(fx("real-mono.mp3"))).toEqual({ ok: false, reason: "not_ogg" });
  });

  it("rejects a real file that is cut anywhere, and one with a flipped byte anywhere in the audio", () => {
    const good = fx("real-mono-opus.ogg");
    for (const cut of [10, 27, 100, 400, good.length >> 1, good.length - 1]) {
      expect(inspectVoiceNote(good.slice(0, cut)).ok).toBe(false);
    }
    for (const at of [40, 90, 300, good.length >> 1, good.length - 20]) {
      const damaged = good.slice();
      damaged[at] ^= 0x01;
      const result = inspectVoiceNote(damaged);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a real file with bytes appended", () => {
    const good = fx("real-mono-opus.ogg");
    const padded = new Uint8Array(good.length + 3);
    padded.set(good);
    expect(inspectVoiceNote(padded)).toEqual({ ok: false, reason: "trailing_data" });
  });
});
