/**
 * Builds small, byte-exact Ogg/Opus files for tests (no audio decoding: the
 * "audio" pages carry arbitrary packet bytes, which is all the container
 * verifier looks at). Lets a test produce a valid mono voice note, a stereo
 * one, a truncated one, a file with a wrong CRC, and so on, without binary
 * fixtures in the repository.
 */

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
}
const TABLE = crcTable();

export interface PageOptions {
  flags: number;
  granule: number;
  serial: number;
  sequence: number;
  packets: Uint8Array[];
  /** Write a wrong CRC on purpose. */
  badCrc?: boolean;
}

export function buildPage(o: PageOptions): Uint8Array {
  const lacing: number[] = [];
  for (const packet of o.packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  const dataLength = o.packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + dataLength);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[4] = 0;
  page[5] = o.flags;
  const view = new DataView(page.buffer);
  view.setUint32(6, o.granule >>> 0, true);
  view.setUint32(10, Math.floor(o.granule / 0x100000000) >>> 0, true);
  view.setUint32(14, o.serial >>> 0, true);
  view.setUint32(18, o.sequence >>> 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of o.packets) {
    page.set(packet, at);
    at += packet.length;
  }
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ TABLE[((crc >>> 24) & 0xff) ^ page[i]]) >>> 0;
  view.setUint32(22, o.badCrc ? (crc ^ 0xdeadbeef) >>> 0 : crc, true);
  return page;
}

export function opusHead(channels: number, opts: { family?: number; version?: number; preSkip?: number } = {}): Uint8Array {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  head[8] = opts.version ?? 1;
  head[9] = channels;
  new DataView(head.buffer).setUint16(10, opts.preSkip ?? 312, true);
  new DataView(head.buffer).setUint32(12, 48000, true);
  head[18] = opts.family ?? 0;
  return head;
}

export function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("wacrm-test");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface OggOpusOptions {
  channels?: number;
  family?: number;
  version?: number;
  /** Audio pages after the two header pages (default 2). */
  audioPages?: number;
  /** Final granule position in 48 kHz samples (default 96312 = 2 s + pre-skip). */
  finalGranule?: number;
  omitEos?: boolean;
  omitTags?: boolean;
  badCrcOnPage?: number;
  serial?: number;
  /** Bytes of the packet in each audio page (default 40; up to ~64000 to build large files). */
  audioPayloadBytes?: number;
}

/** A complete, valid mono Ogg/Opus file unless the options say otherwise. */
export function buildOggOpus(options: OggOpusOptions = {}): Uint8Array {
  const serial = options.serial ?? 0x1234abcd;
  const audioPages = options.audioPages ?? 2;
  const pages: Uint8Array[] = [];
  let sequence = 0;
  pages.push(
    buildPage({
      flags: 0x02,
      granule: 0,
      serial,
      sequence: sequence++,
      packets: [opusHead(options.channels ?? 1, { family: options.family, version: options.version })],
      badCrc: options.badCrcOnPage === 0,
    }),
  );
  pages.push(
    buildPage({
      flags: 0,
      granule: 0,
      serial,
      sequence: sequence++,
      packets: [options.omitTags ? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) : opusTags()],
      badCrc: options.badCrcOnPage === 1,
    }),
  );
  for (let i = 0; i < audioPages; i++) {
    const last = i === audioPages - 1;
    pages.push(
      buildPage({
        flags: last && !options.omitEos ? 0x04 : 0,
        granule: last ? (options.finalGranule ?? Math.max(96312, 960 * (i + 1) + 312)) : 960 * (i + 1) + 312,
        serial,
        sequence: sequence++,
        packets: [new Uint8Array(options.audioPayloadBytes ?? 40).fill((i % 250) + 1)],
        badCrc: options.badCrcOnPage === 2 + i,
      }),
    );
  }
  return concat(...pages);
}
