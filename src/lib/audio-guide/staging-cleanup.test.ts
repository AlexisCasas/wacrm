import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RETENTION_MS,
  MAX_DELETIONS_PER_RUN,
  MIN_RETENTION_MS,
  removeStagingOrphans,
  scanStagingOrphans,
  type StagingStorage,
} from "./staging-cleanup";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Obj { path: string; updatedMs?: number }
/** A fake bucket: `files` are full paths; list() behaves like Storage (folders have id null). */
function fakeBucket(files: Obj[]) {
  const live = new Map(files.map((f) => [f.path, f]));
  const removed: string[] = [];
  const storage: StagingStorage = {
    from: () => ({
      async list(path, { limit, offset }) {
        const prefix = path ? `${path}/` : "";
        const entries = new Map<string, { name: string; id: string | null; created_at?: string; updated_at?: string }>();
        for (const f of live.values()) {
          if (!f.path.startsWith(prefix)) continue;
          const rest = f.path.slice(prefix.length);
          const [head, ...tail] = rest.split("/");
          if (tail.length) entries.set(head, { name: head, id: null });
          else entries.set(head, { name: head, id: `id-${head}`, created_at: iso(f.updatedMs ?? 0), updated_at: iso(f.updatedMs ?? 0) });
        }
        return { data: [...entries.values()].slice(offset, offset + limit), error: null };
      },
      async remove(paths) {
        for (const p of paths) { live.delete(p); removed.push(p); }
        return { data: null, error: null };
      },
    }),
  };
  return { storage, removed, live };
}
const stamp = (ms: number, name = "guia") => `${ms}-${name}.ogg`;
const old = NOW - 10 * DAY;
const fresh = NOW - 2 * 3600 * 1000;

describe("scanStagingOrphans", () => {
  it("lists only editor staging files older than the retention, by BOTH the name's time and the object's own time", async () => {
    const { storage } = fakeBucket([
      { path: `account-${A}/voice-staging/${stamp(old, "orphan")}`, updatedMs: old },
      { path: `account-${A}/voice-staging/${stamp(fresh, "recent")}`, updatedMs: fresh },
      { path: `account-${A}/voice-staging/${stamp(old, "reuploaded")}`, updatedMs: NOW - 3600_000 }, // same name, bytes replaced an hour ago
      { path: `account-${B}/voice-staging/${stamp(old, "other-account")}`, updatedMs: old },
    ]);
    const scan = await scanStagingOrphans({ storage, isReferenced: async () => false, now: () => NOW });
    expect(scan.candidates.map((c) => c.path).sort()).toEqual([
      `account-${A}/voice-staging/${stamp(old, "orphan")}`,
      `account-${B}/voice-staging/${stamp(old, "other-account")}`,
    ].sort());
    expect(scan.counts).toMatchObject({ scannedInStagingFolders: 4, tooRecent: 2, notEditorStaging: 0, referenced: 0 });
  });

  it("never lists the Inbox's own media, promoted voice notes, templates, or anything outside the staging folder, however old", async () => {
    const { storage } = fakeBucket([
      { path: `account-${A}/${stamp(old, "inbox-memo")}`, updatedMs: old },          // the composer's voice note, same bucket, same naming
      { path: `account-${A}/${"a".repeat(64)}.ogg`, updatedMs: old },                 // looks like a promoted note
      { path: `account-${A}/templates/${stamp(old, "header")}`, updatedMs: old },
      { path: `account-${A}/voice-staging/notes.txt`, updatedMs: old },               // wrong name in the right folder
      { path: `account-${A}/voice-staging/${stamp(old, "x").replace(".ogg", ".mp3")}`, updatedMs: old },
      { path: `loose-file.ogg`, updatedMs: old },
      { path: `avatars/${stamp(old, "face")}`, updatedMs: old },
    ]);
    const isReferenced = vi.fn(async () => false);
    const scan = await scanStagingOrphans({ storage, isReferenced, now: () => NOW });
    expect(scan.candidates).toEqual([]);
    expect(scan.counts.notEditorStaging).toBe(2);
    expect(isReferenced).not.toHaveBeenCalled();
  });

  it("leaves out anything a message still references", async () => {
    const path = `account-${A}/voice-staging/${stamp(old, "used")}`;
    const { storage } = fakeBucket([{ path, updatedMs: old }, { path: `account-${A}/voice-staging/${stamp(old, "free")}`, updatedMs: old }]);
    const scan = await scanStagingOrphans({ storage, isReferenced: async (p) => p === path, now: () => NOW });
    expect(scan.candidates.map((c) => c.path)).toEqual([`account-${A}/voice-staging/${stamp(old, "free")}`]);
    expect(scan.counts.referenced).toBe(1);
  });

  it("treats a name stamped in the future, or an object with no timestamp, as not old", async () => {
    // `undated` carries no timestamp at all; `future` is stamped 30 days ahead
    const raw: StagingStorage = { from: () => ({
      list: async (path) => path === "" ? { data: [{ name: `account-${A}`, id: null }], error: null }
        : path.endsWith("voice-staging") ? { data: [{ name: stamp(old, "undated"), id: "x" }, { name: stamp(NOW + 30 * DAY, "future"), id: "y", updated_at: iso(old) }], error: null }
        : { data: [], error: null },
      remove: async () => ({ data: null, error: null }),
    }) };
    const scan = await scanStagingOrphans({ storage: raw, isReferenced: async () => false, now: () => NOW });
    expect(scan.candidates).toEqual([]);
    expect(scan.counts.tooRecent).toBe(2);
  });

  it("refuses a retention under one day, and fails closed when it cannot list", async () => {
    const { storage } = fakeBucket([]);
    await expect(scanStagingOrphans({ storage, isReferenced: async () => false }, MIN_RETENTION_MS - 1)).rejects.toThrow(/at least/);
    await expect(scanStagingOrphans({ storage, isReferenced: async () => false }, Number.NaN)).rejects.toThrow(/at least/);
    const broken: StagingStorage = { from: () => ({ list: async () => ({ data: null, error: { message: "boom" } }), remove: async () => ({ data: null, error: null }) }) };
    await expect(scanStagingOrphans({ storage: broken, isReferenced: async () => false })).rejects.toThrow(/listing/);
    const unsure = fakeBucket([{ path: `account-${A}/voice-staging/${stamp(old)}`, updatedMs: old }]);
    await expect(scanStagingOrphans({ storage: unsure.storage, isReferenced: async () => { throw new Error("db down"); }, now: () => NOW })).rejects.toThrow(/db down/);
  });

  it("pages through large folders", async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ path: `account-${A}/voice-staging/${stamp(old - i, `f${i}`)}`, updatedMs: old }));
    const scan = await scanStagingOrphans({ storage: fakeBucket(files).storage, isReferenced: async () => false, now: () => NOW });
    expect(scan.candidates).toHaveLength(250);
  });
});

describe("removeStagingOrphans", () => {
  const setup = () => {
    const orphan = `account-${A}/voice-staging/${stamp(old, "orphan")}`;
    const bucket = fakeBucket([
      { path: orphan, updatedMs: old },
      { path: `account-${A}/voice-staging/${stamp(fresh, "recent")}`, updatedMs: fresh },
      { path: `account-${A}/${stamp(old, "inbox-memo")}`, updatedMs: old },
    ]);
    return { orphan, ...bucket };
  };

  it("removes exactly the reviewed orphan and nothing else", async () => {
    const { orphan, storage, removed, live } = setup();
    const result = await removeStagingOrphans({ storage, isReferenced: async () => false, now: () => NOW }, [orphan]);
    expect(result).toEqual({ removed: [orphan], skipped: [] });
    expect(removed).toEqual([orphan]);
    expect([...live.keys()].sort()).toEqual([`account-${A}/${stamp(old, "inbox-memo")}`, `account-${A}/voice-staging/${stamp(fresh, "recent")}`].sort());
  });

  it("does nothing without a reviewed list (dry run is the default posture)", async () => {
    const { storage, removed } = setup();
    expect(await removeStagingOrphans({ storage, isReferenced: async () => false, now: () => NOW }, [])).toEqual({ removed: [], skipped: [] });
    expect(removed).toEqual([]);
  });

  it("refuses to remove a reviewed path that is not (or no longer) a candidate: recent, Inbox media, referenced, or unknown", async () => {
    const { storage, removed } = setup();
    const ask = [
      `account-${A}/voice-staging/${stamp(fresh, "recent")}`,
      `account-${A}/${stamp(old, "inbox-memo")}`,
      `account-${A}/voice-staging/${stamp(old, "never-existed")}`,
      "../../etc/passwd",
    ];
    const result = await removeStagingOrphans({ storage, isReferenced: async () => false, now: () => NOW }, ask);
    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(Array(4).fill("not_a_current_candidate"));
    expect(removed).toEqual([]);
    const orphan = `account-${A}/voice-staging/${stamp(old, "orphan")}`;
    const referenced = await removeStagingOrphans({ storage, isReferenced: async () => true, now: () => NOW }, [orphan]);
    expect(referenced.removed).toEqual([]);
  });

  it("skips (and reports) a removal Storage refuses, and caps one run", async () => {
    const orphan = `account-${A}/voice-staging/${stamp(old, "orphan")}`;
    const base = fakeBucket([{ path: orphan, updatedMs: old }]);
    const failing: StagingStorage = { from: (b) => ({ ...base.storage.from(b), remove: async () => ({ data: null, error: { message: "denied" } }) }) };
    expect(await removeStagingOrphans({ storage: failing, isReferenced: async () => false, now: () => NOW }, [orphan])).toEqual({ removed: [], skipped: [{ path: orphan, reason: "storage_error" }] });
    await expect(removeStagingOrphans({ storage: base.storage, isReferenced: async () => false }, Array.from({ length: MAX_DELETIONS_PER_RUN + 1 }, (_, i) => `p${i}`))).rejects.toThrow(/at most/);
  });

  it("the default retention is a week", () => {
    expect(DEFAULT_RETENTION_MS).toBe(7 * DAY);
  });
});
