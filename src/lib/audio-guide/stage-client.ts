"use client";

/**
 * Browser half of adding a voice note to the catalog: check the file here (fast feedback, nothing uploaded if it is wrong), then
 * stage it in the editor's staging folder. The SERVER verifies it again and stores the immutable copy when the audio is added to a
 * product (POST /api/audio-guide/products/:id/items), so nothing in this file is trusted.
 */

import { hasOggExtension, normalizeOggFile } from "@/lib/media/ogg-opus";
import { VOICE_NOTE_MAX_BYTES, inspectVoiceNote, isOggFamilyContentType, type VoiceNoteRejection } from "@/lib/media/voice-note";
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

export type StageResult = { ok: true; path: string; fileName: string } | { ok: false; problem: VoiceNoteProblem };

export async function stageVoiceNote(file: File): Promise<StageResult> {
  if (!hasOggExtension(file.name)) return { ok: false, problem: "needs_ogg" };
  if (file.size > VOICE_NOTE_MAX_BYTES) return { ok: false, problem: "too_large" };
  if (!isOggFamilyContentType(file.type)) return { ok: false, problem: "not_ogg" };
  const local = inspectVoiceNote(new Uint8Array(await file.arrayBuffer()));
  if (!local.ok) return { ok: false, problem: problemOf(local.reason) };
  try {
    const staged = await uploadAccountMedia(VOICE_NOTE_STAGING_BUCKET, normalizeOggFile(file), { subfolder: VOICE_NOTE_STAGING_SUBFOLDER });
    return { ok: true, path: staged.path, fileName: file.name };
  } catch {
    return { ok: false, problem: "upload_failed" };
  }
}
