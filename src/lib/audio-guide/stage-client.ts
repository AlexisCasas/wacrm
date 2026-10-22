"use client";

/**
 * Browser half of adding a voice note to the catalog: prepare and check the file here (fast feedback, nothing uploaded if it is wrong),
 * then stage it in the editor's staging folder. A well-formed file goes up as it is; the one recoverable defect, a complete stream whose
 * last page lacks the end-of-stream flag, is repaired first (`prepareVoiceNote`, the same repair Multimedia uses) and the caller is told
 * so. The SERVER verifies the staged file again with the strict verifier and stores the immutable copy when the audio is added to a
 * product (POST /api/audio-guide/products/:id/items), so nothing in this file is trusted.
 */

import { hasOggExtension, normalizeOggFile } from "@/lib/media/ogg-opus";
import { VOICE_NOTE_MAX_BYTES, isOggFamilyContentType, type VoiceNoteRejection } from "@/lib/media/voice-note";
import { prepareVoiceNote } from "@/lib/media/voice-note-prepare";
import { VOICE_NOTE_STAGING_BUCKET, VOICE_NOTE_STAGING_SUBFOLDER } from "@/lib/media/voice-note-path";
import { uploadAccountMedia } from "@/lib/storage/upload-media";

export type VoiceNoteProblem = "needs_ogg" | "too_large" | "not_ogg" | "not_mono" | "corrupt" | "upload_failed";

/** What a verifier rejection means to a person. */
export function problemOf(reason: VoiceNoteRejection | undefined): VoiceNoteProblem {
  switch (reason) {
    case "not_mono": return "not_mono";
    case "too_large": return "too_large";
    case "not_ogg": case "not_opus": case "opus_version_unsupported": case "bad_channel_mapping": return "not_ogg";
    default: return "corrupt";
  }
}

/** `repaired`: the missing end-of-stream flag was completed before upload. `durationMs` is the length the file declares. */
export type StageResult = { ok: true; path: string; fileName: string; repaired: boolean; durationMs: number } | { ok: false; problem: VoiceNoteProblem };

export async function stageVoiceNote(file: File): Promise<StageResult> {
  if (!hasOggExtension(file.name)) return { ok: false, problem: "needs_ogg" };
  if (file.size > VOICE_NOTE_MAX_BYTES) return { ok: false, problem: "too_large" };
  if (!isOggFamilyContentType(file.type)) return { ok: false, problem: "not_ogg" };
  const prepared = prepareVoiceNote(new Uint8Array(await file.arrayBuffer()));
  if (!prepared.ok) return { ok: false, problem: problemOf(prepared.reason) };
  const toUpload = prepared.repaired
    ? new File([prepared.bytes as BlobPart], file.name, { type: "audio/ogg", lastModified: file.lastModified })
    : normalizeOggFile(file);
  try {
    const staged = await uploadAccountMedia(VOICE_NOTE_STAGING_BUCKET, toUpload, { subfolder: VOICE_NOTE_STAGING_SUBFOLDER });
    return { ok: true, path: staged.path, fileName: file.name, repaired: prepared.repaired !== false, durationMs: prepared.inspection.durationMs };
  } catch {
    return { ok: false, problem: "upload_failed" };
  }
}
