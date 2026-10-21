/**
 * Server-side half of the voice-note contract.
 *
 * The browser stages a candidate file in Storage (so a 16 MB body never has to
 * pass through a Next route, whose proxy buffers at most 10 MB) and then asks
 * the server to PROMOTE it. Promotion is the only way a file becomes usable by
 * a Flow or the catalog:
 *
 *   1. the staging path must be a plain path inside the caller's own account;
 *   2. the object is read in full and verified (`inspectVoiceNote`: mono
 *      Ogg/Opus, every page CRC, end of stream, <= 16 MB);
 *   3. its SHA-256 is computed from THOSE bytes;
 *   4. those same bytes are written, by the service role, to
 *      `voice-notes/account-<id>/<sha256>.ogg` and never overwritten.
 *
 * The staged object stays under the user's control, but nothing downstream
 * reads it: the bytes that were verified are the bytes that were stored, and
 * the destination has no write policy for users, so a later edit of the staged
 * copy cannot change what is sent.
 */

import {
  VOICE_NOTE_MAX_BYTES,
  inspectVoiceNote,
  sha256Hex,
  type VoiceNoteRejection,
} from "@/lib/media/voice-note";
import {
  VOICE_NOTE_BUCKET,
  VOICE_NOTE_STAGING_BUCKET,
  buildVoiceNoteObjectPath,
  isSafeStagingPath,
} from "@/lib/media/voice-note-path";

/** The slice of the Supabase Storage client this module needs (easy to fake in tests). */
export interface VoiceNoteStorageClient {
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean; cacheControl: string },
      ): Promise<{ error: { message: string; statusCode?: string | number } | null }>;
      getPublicUrl(path: string): { data: { publicUrl: string } };
      remove(paths: string[]): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type PromoteVoiceNoteResult =
  | {
      ok: true;
      url: string;
      sha256: string;
      bytes: number;
      durationMs: number;
      objectPath: string;
    }
  | { ok: false; code: "invalid_path" | "not_found" | "rejected" | "storage_error"; reason?: VoiceNoteRejection };

function isDuplicateUpload(error: { message: string; statusCode?: string | number }): boolean {
  return String(error.statusCode ?? "") === "409" || /already exists|duplicate/i.test(error.message);
}

export async function promoteVoiceNote(args: {
  admin: VoiceNoteStorageClient;
  accountId: string;
  stagingPath: unknown;
}): Promise<PromoteVoiceNoteResult> {
  const { admin, accountId, stagingPath } = args;
  if (!isSafeStagingPath(accountId, stagingPath)) return { ok: false, code: "invalid_path" };

  const staging = admin.storage.from(VOICE_NOTE_STAGING_BUCKET);
  const { data: blob, error: downloadError } = await staging.download(stagingPath);
  if (downloadError || !blob) return { ok: false, code: "not_found" };
  // Cheap size gate before pulling an oversized object into memory.
  if (blob.size > VOICE_NOTE_MAX_BYTES) return { ok: false, code: "rejected", reason: "too_large" };

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const inspection = inspectVoiceNote(bytes);
  if (!inspection.ok) return { ok: false, code: "rejected", reason: inspection.reason };

  const sha256 = await sha256Hex(bytes);
  const objectPath = buildVoiceNoteObjectPath(accountId, sha256);
  const destination = admin.storage.from(VOICE_NOTE_BUCKET);
  const { error: uploadError } = await destination.upload(objectPath, bytes, {
    contentType: "audio/ogg",
    // Never overwrite: the name IS the content hash, so an existing object is the same bytes.
    upsert: false,
    cacheControl: "31536000",
  });
  if (uploadError && !isDuplicateUpload(uploadError)) return { ok: false, code: "storage_error" };

  // Best effort: the staged copy is no longer needed and must not accumulate.
  await staging.remove([stagingPath]).catch(() => undefined);

  return {
    ok: true,
    url: destination.getPublicUrl(objectPath).data.publicUrl,
    sha256,
    bytes: inspection.bytes,
    durationMs: inspection.durationMs,
    objectPath,
  };
}

export type VerifyStoredVoiceNoteResult =
  | { ok: true; sha256: string; bytes: number; durationMs: number }
  | { ok: false; code: "invalid_hash" | "not_found" | "rejected"; reason?: VoiceNoteRejection };

/**
 * Re-verifies a voice note that is ALREADY in `voice-notes` (for adding the same file to another product): reads the object of THIS
 * account, runs the full verification again and checks the bytes still hash to the name. The result is what the catalog records, so
 * the caller never supplies size, duration or channels.
 */
export async function verifyStoredVoiceNote(args: {
  admin: VoiceNoteStorageClient;
  accountId: string;
  sha256: unknown;
}): Promise<VerifyStoredVoiceNoteResult> {
  const { admin, accountId, sha256 } = args;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, code: "invalid_hash" };
  const { data: blob, error } = await admin.storage.from(VOICE_NOTE_BUCKET).download(buildVoiceNoteObjectPath(accountId, sha256));
  if (error || !blob) return { ok: false, code: "not_found" };
  if (blob.size > VOICE_NOTE_MAX_BYTES) return { ok: false, code: "rejected", reason: "too_large" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const inspection = inspectVoiceNote(bytes);
  if (!inspection.ok) return { ok: false, code: "rejected", reason: inspection.reason };
  // The name is a promise about the content: if they disagree the object is not what the catalog thinks it is.
  if ((await sha256Hex(bytes)) !== sha256) return { ok: false, code: "rejected", reason: "bad_page_structure" };
  return { ok: true, sha256, bytes: inspection.bytes, durationMs: inspection.durationMs };
}
