import { describe, it, expect } from "vitest";
import { looksLikeOpusOgg, hasOggExtension, normalizeOggFile } from "./ogg-opus";

/** Builds a minimal byte buffer that starts with "OggS" and, when
 *  `withOpusHead` is true, embeds "OpusHead" a bit further in — enough
 *  to satisfy the lightweight signature check without a real encoder. */
function fakeOggBytes(withOpusHead: boolean): Uint8Array {
  const header = "OggS";
  const filler = new Array(20).fill(0); // stand-in for page-header fields
  const payload = withOpusHead ? "OpusHead" : "vorbis..";
  const text = header + String.fromCharCode(...filler) + payload;
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function fileFrom(bytes: Uint8Array, name: string, type = "audio/ogg"): File {
  // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
  // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch (same
  // pattern as message-composer.tsx's finalizeRecording).
  return new File([bytes as unknown as BlobPart], name, { type });
}

describe("looksLikeOpusOgg", () => {
  it("accepts a file starting with OggS and containing OpusHead", async () => {
    const file = fileFrom(fakeOggBytes(true), "voice.ogg");
    expect(await looksLikeOpusOgg(file)).toBe(true);
  });

  it("rejects an Ogg file that is NOT Opus (e.g. Vorbis)", async () => {
    const file = fileFrom(fakeOggBytes(false), "music.ogg");
    expect(await looksLikeOpusOgg(file)).toBe(false);
  });

  it("rejects a file that isn't Ogg at all, even with the right extension", async () => {
    // Looks like an .ogg by name, but the bytes are just plain text —
    // no OggS magic, no OpusHead.
    const file = new File(["this is not audio"], "fake.ogg", { type: "audio/ogg" });
    expect(await looksLikeOpusOgg(file)).toBe(false);
  });

  it("rejects an empty file", async () => {
    const file = new File([], "empty.ogg", { type: "audio/ogg" });
    expect(await looksLikeOpusOgg(file)).toBe(false);
  });

  it("rejects a file with OpusHead present but missing the OggS start", async () => {
    // OpusHead alone isn't enough — it must be inside an actual Ogg
    // container, signaled by the page starting with "OggS".
    const bytes = Uint8Array.from("XXXXOpusHead", (c) => c.charCodeAt(0));
    const file = fileFrom(bytes, "not-ogg.ogg");
    expect(await looksLikeOpusOgg(file)).toBe(false);
  });
});

describe("hasOggExtension", () => {
  it("accepts .ogg case-insensitively", () => {
    expect(hasOggExtension("voice.ogg")).toBe(true);
    expect(hasOggExtension("voice.OGG")).toBe(true);
    expect(hasOggExtension("voice.OgG")).toBe(true);
  });

  it("rejects any other extension", () => {
    expect(hasOggExtension("voice.mp3")).toBe(false);
    expect(hasOggExtension("voice.m4a")).toBe(false);
    expect(hasOggExtension("voice.oga")).toBe(false);
    expect(hasOggExtension("voice")).toBe(false);
  });
});

describe("normalizeOggFile", () => {
  // The `chat-media` bucket's allow-list (migration 023) permits
  // `audio/ogg` but NOT `audio/opus` or a parameterized
  // `audio/ogg; codecs=opus` — either of those passed through verbatim
  // as the upload's Content-Type gets the object rejected by Storage.
  // normalizeOggFile is only ever called after looksLikeOpusOgg has
  // already confirmed the file really is OGG/Opus, so it coerces
  // UNCONDITIONALLY to the bucket's one allowed type, regardless of
  // what the browser reported.
  const MIME_VARIANTS = [
    ["", "empty string"],
    ["application/ogg", "generic Ogg container"],
    ["audio/opus", "Opus-specific MIME (not in the bucket allow-list)"],
    ["audio/ogg", "already the bucket's allowed type"],
    ["audio/ogg; codecs=opus", "parameterized MIME"],
  ] as const;

  it.each(MIME_VARIANTS)("normalizes %s (%s) to exactly audio/ogg", (inputType) => {
    const file = fileFrom(fakeOggBytes(true), "voice.ogg", inputType);
    const normalized = normalizeOggFile(file);
    expect(normalized.type).toBe("audio/ogg");
  });

  it("preserves the original filename", () => {
    const file = fileFrom(fakeOggBytes(true), "my-recording.ogg", "audio/opus");
    expect(normalizeOggFile(file).name).toBe("my-recording.ogg");
  });

  it("preserves the exact bytes (size unchanged)", () => {
    const file = fileFrom(fakeOggBytes(true), "voice.ogg", "audio/opus");
    const normalized = normalizeOggFile(file);
    expect(normalized.size).toBe(file.size);
  });

  it("preserves lastModified", () => {
    const file = fileFrom(fakeOggBytes(true), "voice.ogg", "audio/opus");
    const normalized = normalizeOggFile(file);
    expect(normalized.lastModified).toBe(file.lastModified);
  });

  it("is exactly audio/ogg even when the input already was — never a different File instance masquerading as a no-op", () => {
    const file = fileFrom(fakeOggBytes(true), "voice.ogg", "audio/ogg");
    const normalized = normalizeOggFile(file);
    expect(normalized.type).toBe("audio/ogg");
    expect(normalized.name).toBe(file.name);
    expect(normalized.size).toBe(file.size);
  });
});
