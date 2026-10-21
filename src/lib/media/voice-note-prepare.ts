/**
 * Prepares an Ogg/Opus voice note for upload: accepts a well-formed file as it is and repairs the ONE structural defect that is
 * recoverable without touching a single audio byte, a stream that is complete but whose last page lacks the end-of-stream flag
 * (several recorders and muxers never set it).
 *
 * What is NOT recoverable stays rejected by `inspectVoiceNote` exactly as before: a bad page CRC, a gap in the page sequence, a
 * page cut short, a packet left open at the end, a stereo or non-Opus stream. The repair never invents or drops audio: it sets
 * one flag bit on the last page and recomputes that page's CRC.
 *
 * Honest limit: an Ogg stream cut exactly at a page boundary looks the same as a complete stream without the flag; structure
 * alone cannot tell them apart. So a repaired file is reported as `repaired` (the editor tells the person and shows the
 * duration to compare with what they expect), and every other consistency check below must hold first.
 *
 * Pure and dependency-free, like `inspectVoiceNote`, which still has the last word on the result.
 */

import { inspectVoiceNote, pageCrc, type VoiceNoteInspection, type VoiceNoteRejection } from "./voice-note";

const FLAG_EOS = 0x04;
const PAGE_HEADER_FIXED = 27;

/** Opus frame length in microseconds-of-48k-samples, indexed by the TOC configuration (RFC 6716 table 2). */
const FRAME_SAMPLES_48K = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960,
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** Longest Opus packet (120 ms): the most an encoder may trim from the end of a stream in the final granule position. */
const MAX_END_TRIM_SAMPLES = 5760;

export type VoiceNotePreparation =
  | { ok: true; bytes: Uint8Array; repaired: false; inspection: Extract<VoiceNoteInspection, { ok: true }> }
  | { ok: true; bytes: Uint8Array; repaired: "missing_end_of_stream"; inspection: Extract<VoiceNoteInspection, { ok: true }> }
  | { ok: false; reason: VoiceNoteRejection };

function u32le(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * Walks the (already CRC-checked) pages and returns where the last one starts plus the 48 kHz samples that every audio packet
 * adds up to, or null when a packet is left open at the end or a packet cannot be measured.
 */
function measure(bytes: Uint8Array): { lastPageStart: number; packetSamples: number } | null {
  let offset = 0;
  let pageIndex = 0;
  let lastPageStart = 0;
  let packetSamples = 0;
  let open: number[] = []; // first bytes of the packet being assembled across pages (TOC and the frame-count byte)
  let openLength = 0;
  while (offset < bytes.length) {
    const segments = bytes[offset + 26];
    let at = offset + PAGE_HEADER_FIXED + segments;
    let lace255 = false;
    for (let i = 0; i < segments; i++) {
      const lace = bytes[offset + PAGE_HEADER_FIXED + i];
      if (open.length < 2) for (let k = 0; k < lace && open.length < 2; k++) open.push(bytes[at + k]);
      openLength += lace;
      at += lace;
      lace255 = lace === 255;
      if (lace < 255) {
        // A packet ended. Pages 0 and 1 hold OpusHead and OpusTags, which carry no audio.
        if (pageIndex >= 2) {
          if (openLength === 0) return null;
          const toc = open[0];
          const frame = FRAME_SAMPLES_48K[toc >> 3];
          const code = toc & 3;
          const frames = code === 0 ? 1 : code === 3 ? (open.length > 1 ? open[1] & 0x3f : 0) : 2;
          if (frames === 0) return null;
          packetSamples += frame * frames;
        }
        open = [];
        openLength = 0;
      }
    }
    const pageLength = PAGE_HEADER_FIXED + segments + dataLengthOf(bytes, offset, segments);
    if (offset + pageLength >= bytes.length) {
      // last page: a packet that continues past it means the file was cut short
      if (lace255) return null;
      lastPageStart = offset;
    }
    offset += pageLength;
    pageIndex++;
  }
  if (openLength !== 0) return null;
  return { lastPageStart, packetSamples };
}

function dataLengthOf(bytes: Uint8Array, offset: number, segments: number): number {
  let length = 0;
  for (let i = 0; i < segments; i++) length += bytes[offset + PAGE_HEADER_FIXED + i];
  return length;
}

export function prepareVoiceNote(input: Uint8Array): VoiceNotePreparation {
  const first = inspectVoiceNote(input);
  if (first.ok) return { ok: true, bytes: input, repaired: false, inspection: first };
  if (first.reason !== "missing_end_of_stream") return { ok: false, reason: first.reason };

  // Reaching this reason means every page already passed: capture pattern, serial, sequence, CRC, OpusHead (mono) and
  // OpusTags. Only the flag on the last page is missing; check that the stream really ends where it says before setting it.
  const measured = measure(input);
  if (!measured) return { ok: false, reason: "truncated" };
  const { lastPageStart, packetSamples } = measured;

  const preSkip = input[PAGE_HEADER_FIXED + input[26] + 10] | (input[PAGE_HEADER_FIXED + input[26] + 11] << 8);
  const granule = u32le(input, lastPageStart + 10) * 0x100000000 + u32le(input, lastPageStart + 6);
  const expected = packetSamples + preSkip;
  // A granule position beyond what the packets can hold, or far below it, means the container and its payload disagree.
  if (granule > expected || expected - granule > MAX_END_TRIM_SAMPLES) return { ok: false, reason: "truncated" };

  const repaired = new Uint8Array(input);
  repaired[lastPageStart + 5] |= FLAG_EOS;
  const pageLength =
    PAGE_HEADER_FIXED + repaired[lastPageStart + 26] + dataLengthOf(repaired, lastPageStart, repaired[lastPageStart + 26]);
  const crc = pageCrc(repaired, lastPageStart, pageLength);
  repaired[lastPageStart + 22] = crc & 0xff;
  repaired[lastPageStart + 23] = (crc >>> 8) & 0xff;
  repaired[lastPageStart + 24] = (crc >>> 16) & 0xff;
  repaired[lastPageStart + 25] = (crc >>> 24) & 0xff;

  // The strict inspector still decides, on the repaired bytes.
  const second = inspectVoiceNote(repaired);
  if (!second.ok) return { ok: false, reason: second.reason };
  return { ok: true, bytes: repaired, repaired: "missing_end_of_stream", inspection: second };
}
