/**
 * Strict verification of a WhatsApp voice note: an Ogg container that carries
 * ONE mono Opus stream, byte-for-byte well formed.
 *
 * Why this exists next to `ogg-opus.ts`: that module only probes the first
 * 4 KB for the `OggS` / `OpusHead` markers, which is enough for an agent
 * attaching a memo from the inbox but not for a catalog of guide audios that
 * must render exactly like a note recorded on a phone. Meta only renders the
 * voice-note bubble for OGG with OPUS and MONO input (stereo, Vorbis, or a
 * renamed MP3 end up as a plain attachment or a send error), so this walks the
 * WHOLE file:
 *
 *   - every page: `OggS` capture pattern, version 0, a consistent serial
 *     number, consecutive page sequence numbers, and a correct page CRC;
 *   - the first page is the beginning-of-stream page and holds only `OpusHead`
 *     (version 0.x, ONE channel, channel-mapping family 0);
 *   - the next page starts `OpusTags`;
 *   - the last page carries the end-of-stream flag and nothing follows it
 *     (a truncated upload or trailing garbage is rejected);
 *   - the duration is derived from the final granule position.
 *
 * Pure and dependency-free so the SAME function runs in the browser (fail fast
 * before uploading) and on the server (the authoritative check). Never throws:
 * a malformed input resolves to `{ ok: false, reason }`.
 */

/** Meta's cap for an audio message, and the buckets' `file_size_limit`. */
export const VOICE_NOTE_MAX_BYTES = 16 * 1024 * 1024;

export type VoiceNoteRejection =
  | "empty"
  | "too_large"
  | "not_ogg"
  | "truncated"
  | "crc_mismatch"
  | "bad_page_structure"
  | "not_opus"
  | "opus_version_unsupported"
  | "not_mono"
  | "bad_channel_mapping"
  | "missing_opus_tags"
  | "missing_end_of_stream"
  | "trailing_data"
  | "no_audio";

export type VoiceNoteInspection =
  | {
      ok: true;
      channels: 1;
      /** Opus pre-skip, in 48 kHz samples. */
      preSkip: number;
      /** Original input sample rate recorded by the encoder (informational). */
      inputSampleRate: number;
      durationMs: number;
      pages: number;
      bytes: number;
    }
  | { ok: false; reason: VoiceNoteRejection; channels?: number };

const OGGS = [0x4f, 0x67, 0x67, 0x53];
const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
const OPUS_TAGS = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73];

const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

const PAGE_HEADER_FIXED = 27;
const OPUS_HEAD_MIN_LENGTH = 19;

let crcTable: Uint32Array | null = null;

/** Ogg CRC-32: polynomial 0x04C11DB7, MSB first, init 0, no final XOR. */
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC of `page` with its own CRC field (bytes 22..25) treated as zero. */
export function pageCrc(bytes: Uint8Array, start: number, length: number): number {
  const table = getCrcTable();
  let crc = 0;
  for (let i = 0; i < length; i++) {
    const inCrcField = i >= 22 && i < 26;
    const b = inCrcField ? 0 : bytes[start + i];
    crc = ((crc << 8) ^ table[((crc >>> 24) & 0xff) ^ b]) >>> 0;
  }
  return crc >>> 0;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  );
}

function startsWithAt(bytes: Uint8Array, at: number, needle: readonly number[]): boolean {
  if (at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (bytes[at + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Verify that `bytes` (the COMPLETE file) is a well-formed mono Ogg/Opus
 * stream within Meta's size limit.
 */
export function inspectVoiceNote(bytes: Uint8Array): VoiceNoteInspection {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > VOICE_NOTE_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (!startsWithAt(bytes, 0, OGGS)) return { ok: false, reason: "not_ogg" };

  let offset = 0;
  let pageIndex = 0;
  let serial = 0;
  let lastFlags = 0;
  let lastGranuleLow = 0;
  let lastGranuleHigh = 0;
  let preSkip = 0;
  let inputSampleRate = 0;

  while (offset < bytes.length) {
    if (!startsWithAt(bytes, offset, OGGS)) {
      // Bytes that are not a page, after a complete stream, are trailing
      // data; anywhere else they are a damaged container.
      return {
        ok: false,
        reason: (lastFlags & FLAG_EOS) !== 0 ? "trailing_data" : "bad_page_structure",
      };
    }
    if ((lastFlags & FLAG_EOS) !== 0) return { ok: false, reason: "trailing_data" };
    if (offset + PAGE_HEADER_FIXED > bytes.length) return { ok: false, reason: "truncated" };

    const version = bytes[offset + 4];
    const flags = bytes[offset + 5];
    const segmentCount = bytes[offset + 26];
    const headerLength = PAGE_HEADER_FIXED + segmentCount;
    if (version !== 0) return { ok: false, reason: "bad_page_structure" };
    if (offset + headerLength > bytes.length) return { ok: false, reason: "truncated" };

    let dataLength = 0;
    for (let i = 0; i < segmentCount; i++) dataLength += bytes[offset + PAGE_HEADER_FIXED + i];
    const pageLength = headerLength + dataLength;
    if (offset + pageLength > bytes.length) return { ok: false, reason: "truncated" };

    if (pageCrc(bytes, offset, pageLength) !== u32le(bytes, offset + 22)) {
      return { ok: false, reason: "crc_mismatch" };
    }

    const pageSerial = u32le(bytes, offset + 14);
    const pageSequence = u32le(bytes, offset + 18);
    const dataStart = offset + headerLength;

    if (pageIndex === 0) {
      if ((flags & FLAG_BOS) === 0 || (flags & FLAG_CONTINUED) !== 0) {
        return { ok: false, reason: "bad_page_structure" };
      }
      serial = pageSerial;
      // The identification header must be the one and only packet of page 0.
      let firstPacketLength = 0;
      let packetEnded = false;
      let packetsOnPage = 0;
      for (let i = 0; i < segmentCount; i++) {
        const lace = bytes[offset + PAGE_HEADER_FIXED + i];
        if (!packetEnded) firstPacketLength += lace;
        if (lace < 255) {
          packetsOnPage++;
          packetEnded = true;
        }
      }
      if (!startsWithAt(bytes, dataStart, OPUS_HEAD)) return { ok: false, reason: "not_opus" };
      if (!packetEnded || packetsOnPage !== 1 || firstPacketLength < OPUS_HEAD_MIN_LENGTH) {
        return { ok: false, reason: "bad_page_structure" };
      }
      const opusVersion = bytes[dataStart + 8];
      if ((opusVersion & 0xf0) !== 0) return { ok: false, reason: "opus_version_unsupported" };
      const channels = bytes[dataStart + 9];
      if (channels !== 1) {
        return { ok: false, reason: channels === 0 ? "bad_channel_mapping" : "not_mono", channels };
      }
      preSkip = bytes[dataStart + 10] | (bytes[dataStart + 11] << 8);
      inputSampleRate = u32le(bytes, dataStart + 12);
      // Family 0 is the only mapping defined for one channel.
      if (bytes[dataStart + 18] !== 0) return { ok: false, reason: "bad_channel_mapping", channels };
    } else {
      if ((flags & FLAG_BOS) !== 0 || pageSerial !== serial) {
        return { ok: false, reason: "bad_page_structure" };
      }
      if (pageIndex === 1) {
        if ((flags & FLAG_CONTINUED) !== 0 || !startsWithAt(bytes, dataStart, OPUS_TAGS)) {
          return { ok: false, reason: "missing_opus_tags" };
        }
      }
    }
    if (pageSerial !== serial || pageSequence !== pageIndex) {
      return { ok: false, reason: "bad_page_structure" };
    }

    lastFlags = flags;
    lastGranuleLow = u32le(bytes, offset + 6);
    lastGranuleHigh = u32le(bytes, offset + 10);
    offset += pageLength;
    pageIndex++;
  }

  if (pageIndex < 3) {
    // identification page + comment page + at least one audio page
    return { ok: false, reason: pageIndex === 2 ? "no_audio" : "truncated" };
  }
  if ((lastFlags & FLAG_EOS) === 0) return { ok: false, reason: "missing_end_of_stream" };
  // Granule position -1 (all ones) means "no packet finishes on this page".
  if (lastGranuleLow === 0xffffffff && lastGranuleHigh === 0xffffffff) {
    return { ok: false, reason: "no_audio" };
  }
  const granule = lastGranuleHigh * 0x100000000 + lastGranuleLow;
  const samples = granule - preSkip;
  if (!Number.isFinite(samples) || samples <= 0) return { ok: false, reason: "no_audio" };

  return {
    ok: true,
    channels: 1,
    preSkip,
    inputSampleRate,
    // Opus granule positions always count 48 kHz samples.
    durationMs: Math.round(samples / 48),
    pages: pageIndex,
    bytes: bytes.length,
  };
}

/**
 * The media type of an upload with any parameters removed and lower-cased:
 * `Audio/OGG; codecs=opus` -> `audio/ogg`.
 */
export function baseContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

const OGG_FAMILY_TYPES = new Set(["", "audio/ogg", "audio/opus", "application/ogg"]);

/**
 * Whether the type a client DECLARED is compatible with an Ogg/Opus file. The
 * declaration is advisory only (browsers report "" or `application/ogg` for a
 * perfectly good file); the bytes decide. This only turns away a declaration
 * that plainly names another format, such as `audio/mpeg`.
 */
export function isOggFamilyContentType(raw: string | null | undefined): boolean {
  return OGG_FAMILY_TYPES.has(baseContentType(raw));
}

/** SHA-256 of `bytes` as lower-case hex (WebCrypto: browser and Node 20+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
