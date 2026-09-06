"use client";

/**
 * Shared image/video/document picker for a `send_media` step's config.
 *
 * Extracted from Flows' `node-config-form.tsx` (`SendMediaForm`) so
 * Automations' builder can offer the exact same upload/preview/caption/
 * ManyChat-bridge UI without a second hand-rolled copy — both engines'
 * `send_media` step share the same config shape (`media_type`,
 * `media_url`, `caption`, `filename`, `manychat_bridge_flow_ns`; see
 * `SendMediaNodeConfig` in `@/lib/flows/types` and `SendMediaStepConfig`
 * in `@/types`).
 *
 * Deliberately excludes the node-graph-only `next_node_key` row —
 * Flows' `SendMediaForm` wraps this component with its own
 * `NextNodeRow`; Automations has no such field at all.
 *
 * Takes label strings as props rather than a `useTranslations` bundle
 * so this component isn't tied to either caller's i18n namespace
 * (`Flows.builder.form` vs `Automations.builder.config`).
 */

import { useCallback, useRef, useState } from "react";
import { Loader2, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

export type MediaPickerKind = "image" | "video" | "document";

export interface MediaPickerValue {
  media_type?: MediaPickerKind;
  media_url?: string;
  caption?: string;
  filename?: string;
  manychat_bridge_flow_ns?: string;
}

export interface MediaPickerLabels {
  mediaTypeLabel: string;
  imageLabel: string;
  videoLabel: string;
  documentLabel: string;
  fileLabel: string;
  removeFile: string;
  uploading: string;
  clickToUpload: string;
  captionLabel: string;
  filenameLabel: string;
  filenamePlaceholder: string;
  manychatBridgeFlowNsLabel: string;
  manychatBridgeFlowNsHelp: string;
}

/** The bucket both Flows and Automations upload send_media assets to —
 *  account-scoped per migration 020, no per-feature bucket needed. */
export const MEDIA_PICKER_BUCKET = "flow-media";

// Mirrors the bucket's allowed_mime_types from migration 016. Kept in
// sync with the storage policy so the picker rejects unsupported files
// before they hit the network rather than failing with a confusing
// Supabase RLS / mime-type error.
const MEDIA_ACCEPT: Record<MediaPickerKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

export function MediaPicker({
  value,
  onChange,
  labels,
  bucket = MEDIA_PICKER_BUCKET,
}: {
  value: MediaPickerValue;
  onChange: (patch: Record<string, unknown>) => void;
  labels: MediaPickerLabels;
  bucket?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const mediaType = value.media_type ?? "image";
  const isDocument = mediaType === "document";
  const displayName =
    value.filename ||
    (value.media_url ? value.media_url.split("/").pop() ?? "" : "");

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is 16 MB.`,
        );
        return;
      }
      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia(bucket, file);
        // Patch all fields in one call so the form doesn't re-render
        // with a half-uploaded state.
        onChange({
          media_url: publicUrl,
          filename: file.name,
        });
        toast.success("File uploaded.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [bucket, onChange],
  );

  const handleClear = () => {
    onChange({ media_url: "", filename: "" });
  };

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{labels.mediaTypeLabel}</label>
        <Select
          value={mediaType}
          onValueChange={(v) => {
            // Changing type clears the existing file — the bucket
            // accepts different MIME sets per type and a previously
            // uploaded PDF can't be sent as an image.
            onChange({
              media_type: v as MediaPickerKind,
              media_url: "",
              filename: "",
            });
          }}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">{labels.imageLabel}</SelectItem>
            <SelectItem value="video">{labels.videoLabel}</SelectItem>
            <SelectItem value="document">{labels.documentLabel}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{labels.fileLabel}</label>
        {value.media_url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <a
              href={value.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
              title={displayName || value.media_url}
            >
              {displayName || value.media_url}
            </a>
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={labels.removeFile}
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {labels.uploading}
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                {labels.clickToUpload}
              </>
            )}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{labels.captionLabel}</label>
        <Textarea
          value={value.caption ?? ""}
          onChange={(e) => onChange({ caption: e.target.value })}
          rows={2}
          className="bg-muted"
        />
      </div>

      {isDocument && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {labels.filenameLabel}
          </label>
          <Input
            value={value.filename ?? ""}
            onChange={(e) => onChange({ filename: e.target.value })}
            placeholder={labels.filenamePlaceholder}
            className="bg-muted text-xs"
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          {labels.manychatBridgeFlowNsLabel}
        </label>
        <Input
          value={value.manychat_bridge_flow_ns ?? ""}
          onChange={(e) => onChange({ manychat_bridge_flow_ns: e.target.value })}
          placeholder="content2026..."
          className="bg-muted font-mono text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {labels.manychatBridgeFlowNsHelp}
        </p>
      </div>
    </>
  );
}
