/**
 * Lightweight OGG/Opus detection for the "Upload voice note" composer
 * flow (P0.1 — audio uploaded from disk as a WhatsApp voice note).
 *
 * A voice note MUST be Opus-encoded inside an Ogg container: Meta's
 * `audio.voice = true` flag renders a WhatsApp voice-note bubble, but
 * only actually plays correctly for Ogg/Opus. A `.ogg`-named file that
 * is secretly something else (renamed MP3, empty file, corrupted
 * upload) would silently produce a broken voice note on the customer's
 * side, so this is checked BEFORE upload, not left to Meta to reject.
 *
 * This is deliberately NOT a full Ogg container parser — just enough
 * to catch the obvious "not actually Opus" case per the spec: read a
 * small prefix and look for the `OggS` page-capture pattern at the very
 * start plus the `OpusHead` codec-identification string that Opus (and
 * only Opus) writes into an Ogg stream's first packet. Both are ASCII
 * byte sequences, checked directly against the raw bytes — no text
 * decoding, so no encoding-related false negatives/positives.
 */

/** OggS page-capture pattern — every Ogg page (and thus a valid Ogg
 *  file's very first byte) starts with this. */
const OGG_PAGE_MAGIC = "OggS";

/** The codec-identification string Opus writes into an Ogg stream's
 *  first packet. Absent from any other codec (Vorbis writes "vorbis",
 *  FLAC-in-Ogg writes "fLaC", etc.), so its presence is a reliable
 *  positive signal without needing to parse packet boundaries. */
const OPUS_HEAD_MAGIC = "OpusHead";

/** OpusHead lives in the very first Ogg page, well within the first
 *  few hundred bytes of a real file — reading a small prefix is enough
 *  without decoding the container. */
const HEADER_PROBE_BYTES = 4096;

/** True when `haystack` starts with the ASCII bytes of `needle`. */
function bytesStartWith(haystack: Uint8Array, needle: string): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[i] !== needle.charCodeAt(i)) return false;
  }
  return true;
}

/** True when the ASCII bytes of `needle` appear anywhere in `haystack`. */
function bytesInclude(haystack: Uint8Array, needle: string): boolean {
  const codes = Array.from(needle, (c) => c.charCodeAt(0));
  const limit = haystack.length - codes.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (haystack[i + j] !== codes[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Read a small prefix of `file` and check it looks like an Ogg
 * container carrying an Opus stream. Never throws on a malformed/empty
 * file — a read failure or a file too short to contain the markers
 * simply resolves `false`, which is exactly "reject this as not a
 * valid voice note."
 */
export async function looksLikeOpusOgg(file: File): Promise<boolean> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer();
  } catch {
    return false;
  }
  const bytes = new Uint8Array(buffer);
  return bytesStartWith(bytes, OGG_PAGE_MAGIC) && bytesInclude(bytes, OPUS_HEAD_MAGIC);
}

/** True for a `.ogg` extension, case-insensitive — the picker's own
 *  first-pass filter before the (more expensive) byte-signature check. */
export function hasOggExtension(filename: string): boolean {
  return /\.ogg$/i.test(filename);
}

/**
 * Rewrap `file` so its MIME type is ALWAYS exactly `audio/ogg`,
 * preserving the original name and bytes. Called only after
 * `looksLikeOpusOgg` has already confirmed the file really is
 * OGG/Opus — at that point the browser-reported `file.type` is not
 * just unreliable, it can be actively wrong for our purposes:
 *
 *   - `""` / `application/ogg` — browsers that report nothing useful
 *     or the generic container type.
 *   - `audio/opus`, `audio/ogg; codecs=opus` — technically-accurate
 *     MIME strings some browsers/OSes DO report for an Opus-in-Ogg
 *     file, but neither is in migration 023's `chat-media` bucket
 *     allow-list (only `audio/ogg` is). Passing either through as
 *     the upload's Content-Type gets the object rejected by Storage
 *     with a MIME error — a real regression this function used to
 *     have (it special-cased `audio/opus` as "already fine").
 *
 * Coercing unconditionally to the bucket's one allowed audio-container
 * type sidesteps every such variant without needing to enumerate them.
 * A file already reporting exactly `audio/ogg` still gets rewrapped —
 * harmless (same type in, same type out) and keeps this function's
 * contract simple: the output is ALWAYS `audio/ogg`, never "whatever
 * the browser said, verbatim."
 */
export function normalizeOggFile(file: File): File {
  return new File([file], file.name, {
    type: "audio/ogg",
    lastModified: file.lastModified,
  });
}
