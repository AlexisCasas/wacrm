/**
 * Finding — and, only on an explicit instruction, removing — the temporary files the voice-note editor leaves in `chat-media`.
 *
 * The editor stages a candidate file at `account-<id>/voice-staging/<epoch ms>-<name>.ogg`, asks the server to verify it, and the
 * server copies the verified bytes to `voice-notes` and removes the staged copy. A staged file is left behind only when the
 * browser closes (or the verification call fails) between those two steps.
 *
 * What makes this safe next to the Inbox's own media in the same bucket:
 *   - a file is a candidate ONLY if its whole path is the editor's staging path and name (`stagedObjectTimestamp`): nothing
 *     else in `chat-media` can ever match, so a message attachment, a template header or a promoted voice note is never listed;
 *   - it must be older than the retention period by BOTH the time in its name and the object's own last-modified time, so a file
 *     that was re-uploaded under the same name is treated as new;
 *   - it must not be referenced by any message;
 *   - nothing is deleted without the exact list of paths the operator reviewed, each of which is re-checked at that moment;
 *   - the retention floor is one day and a run removes at most MAX_DELETIONS_PER_RUN files.
 * Nothing here is wired to a scheduler or an API route: running it is a separate, approved operational step.
 */

import { stagedObjectTimestamp, VOICE_NOTE_STAGING_BUCKET, VOICE_NOTE_STAGING_SUBFOLDER } from "@/lib/media/voice-note-path";

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_DELETIONS_PER_RUN = 200;
const PAGE = 100;

interface ListedObject {
  name: string;
  id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** The slice of the Storage client this needs (a real `supabase.storage` satisfies it). */
export interface StagingStorage {
  from(bucket: string): {
    list(path: string, options: { limit: number; offset: number }): Promise<{ data: ListedObject[] | null; error: { message: string } | null }>;
    remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

export interface StagingCleanupDeps {
  storage: StagingStorage;
  /** True when anything (a message) still points at this object path. Failing to know must throw, never answer false. */
  isReferenced(path: string): Promise<boolean>;
  now?: () => number;
}

export interface StagingCandidate {
  path: string;
  accountId: string;
  stagedAtMs: number;
  lastModifiedMs: number;
  ageMs: number;
}

export interface StagingScan {
  candidates: StagingCandidate[];
  counts: { scannedInStagingFolders: number; tooRecent: number; notEditorStaging: number; referenced: number };
}

function assertRetention(retentionMs: number) {
  if (!Number.isFinite(retentionMs) || retentionMs < MIN_RETENTION_MS) {
    throw new Error(`retention must be at least ${MIN_RETENTION_MS / 3_600_000} hours`);
  }
}

async function listAll(deps: StagingCleanupDeps, folder: string): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await deps.storage.from(VOICE_NOTE_STAGING_BUCKET).list(folder, { limit: PAGE, offset });
    if (error) throw new Error(`listing ${folder || "(root)"} failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Read-only: lists what WOULD be removed. Deletes nothing. */
export async function scanStagingOrphans(deps: StagingCleanupDeps, retentionMs = DEFAULT_RETENTION_MS): Promise<StagingScan> {
  assertRetention(retentionMs);
  const now = (deps.now ?? Date.now)();
  const counts = { scannedInStagingFolders: 0, tooRecent: 0, notEditorStaging: 0, referenced: 0 };
  const candidates: StagingCandidate[] = [];

  const accountFolders = (await listAll(deps, "")).filter((o) => o.id === null && /^account-[0-9a-fA-F-]{36}$/.test(o.name));
  for (const folder of accountFolders) {
    const stagingFolder = `${folder.name}/${VOICE_NOTE_STAGING_SUBFOLDER}`;
    for (const object of await listAll(deps, stagingFolder)) {
      if (object.id === null) continue; // a sub-folder, not a file
      counts.scannedInStagingFolders++;
      const path = `${stagingFolder}/${object.name}`;
      const staged = stagedObjectTimestamp(path);
      if (!staged || staged.accountId !== folder.name.slice("account-".length).toLowerCase()) {
        counts.notEditorStaging++;
        continue;
      }
      const modified = Date.parse(object.updated_at ?? object.created_at ?? "");
      const lastModifiedMs = Number.isFinite(modified) ? modified : now; // unknown age counts as brand new
      const newest = Math.max(staged.stagedAtMs, lastModifiedMs);
      // A name stamped in the future is not something this code can reason about: leave it.
      if (staged.stagedAtMs > now + 24 * 60 * 60 * 1000 || now - newest < retentionMs) {
        counts.tooRecent++;
        continue;
      }
      if (await deps.isReferenced(path)) {
        counts.referenced++;
        continue;
      }
      candidates.push({ path, accountId: staged.accountId, stagedAtMs: staged.stagedAtMs, lastModifiedMs, ageMs: now - newest });
    }
  }
  candidates.sort((a, b) => a.stagedAtMs - b.stagedAtMs);
  return { candidates, counts };
}

export interface StagingCleanupResult {
  removed: string[];
  /** Reviewed paths that were not removed, with why (no longer a candidate, not found, ...). */
  skipped: Array<{ path: string; reason: "not_a_current_candidate" | "storage_error" }>;
}

/**
 * Removes ONLY the paths the operator reviewed (`confirmedPaths`), and only those that are still candidates right now. A path that
 * is not editor staging, is too recent, was re-uploaded, or became referenced is skipped even if it was in the reviewed list.
 */
export async function removeStagingOrphans(
  deps: StagingCleanupDeps,
  confirmedPaths: readonly string[],
  retentionMs = DEFAULT_RETENTION_MS,
): Promise<StagingCleanupResult> {
  assertRetention(retentionMs);
  if (!Array.isArray(confirmedPaths) || confirmedPaths.length === 0) return { removed: [], skipped: [] };
  if (confirmedPaths.length > MAX_DELETIONS_PER_RUN) throw new Error(`at most ${MAX_DELETIONS_PER_RUN} files per run`);
  const unique = [...new Set(confirmedPaths)];

  const current = new Set((await scanStagingOrphans(deps, retentionMs)).candidates.map((c) => c.path));
  const removed: string[] = [];
  const skipped: StagingCleanupResult["skipped"] = [];
  for (const path of unique) {
    if (!current.has(path) || !stagedObjectTimestamp(path)) {
      skipped.push({ path, reason: "not_a_current_candidate" });
      continue;
    }
    const { error } = await deps.storage.from(VOICE_NOTE_STAGING_BUCKET).remove([path]);
    if (error) skipped.push({ path, reason: "storage_error" });
    else removed.push(path);
  }
  return { removed, skipped };
}
