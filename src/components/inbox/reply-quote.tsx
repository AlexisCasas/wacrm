"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";

/**
 * The compact parent-message shape shared by bubbles and the composer.
 * `id` is the internal messages UUID used by reply_to_message_id and by the
 * existing MediaLightbox gallery.
 */
export interface ReplyQuoteData {
  id: string;
  authorLabel: string;
  preview: string;
  contentType?: Message["content_type"];
  mediaUrl?: string;
}

interface ReplyQuoteProps extends ReplyQuoteData {
  /** Sender label of the quoted message: "You" for our own messages,
   *  contact name for customer-sent messages. Caller resolves this — the
   *  quote component doesn't see the parent Message. */
  /** Present → renders the composer-chip variant with an X button. Absent →
   *  renders the embedded-in-bubble variant. */
  onDismiss?: () => void;
  /** True when embedded inside an outbound (primary-filled) bubble, so the
   *  quote must read against the primary surface rather than the neutral
   *  foreground — otherwise it goes low-contrast in light mode. */
  onPrimary?: boolean;
  /** Opens the existing thread lightbox for the quoted parent image. */
  onOpenMedia?: (messageId: string) => void;
}

export function ReplyQuote({
  id,
  authorLabel,
  preview,
  contentType,
  mediaUrl,
  onDismiss,
  onPrimary = false,
  onOpenMedia,
}: ReplyQuoteProps) {
  const t = useTranslations("Inbox.replyQuote");
  const isChip = !!onDismiss;
  const { src, status } = useMediaBlobUrl(
    contentType === "image" ? mediaUrl : undefined,
  );
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | undefined>();
  const imageFailed = failedMediaUrl === mediaUrl;

  const hasImage = contentType === "image" && !!mediaUrl;
  const canShowImage = hasImage && status === "ready" && !!src && !imageFailed;
  const showImagePlaceholder = hasImage && status === "loading" && !imageFailed;

  const thumbnail = canShowImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className="h-10 w-10 shrink-0 rounded object-cover"
      onError={() => setFailedMediaUrl(mediaUrl)}
    />
  ) : null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 border-l-2 px-2 py-1",
        onPrimary ? "border-primary-foreground/50" : "border-primary",
        isChip
          ? "rounded-md bg-muted/80"
          : onPrimary
            ? "mb-1.5 rounded-md bg-primary-foreground/15"
            : "mb-1.5 rounded-md bg-background/20",
      )}
    >
      {showImagePlaceholder && (
        <div
          aria-hidden="true"
          className="h-10 w-10 shrink-0 animate-pulse rounded bg-muted"
        />
      )}
      {thumbnail &&
        (onOpenMedia ? (
          <button
            type="button"
            onClick={() => onOpenMedia(id)}
            aria-label={preview}
            className="shrink-0 rounded outline-none ring-offset-2 ring-offset-transparent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {thumbnail}
          </button>
        ) : (
          thumbnail
        ))}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "truncate text-[11px] font-medium",
            onPrimary ? "text-primary-foreground" : "text-primary",
          )}
        >
          {authorLabel}
        </div>
        {/* Wrap the preview instead of truncating to a single line.
         *  `truncate` (white-space: nowrap) forced the quote onto one
         *  impossibly-wide line and — because the parent flex chain
         *  lacked `min-w-0` at every step — pushed the entire inbox
         *  layout wider, shoving the contact sidebar off-screen.
         *  `break-words` also wraps long URLs that have no whitespace
         *  to break on. Issue #165. */}
        <div className="whitespace-pre-wrap break-words text-xs text-foreground/80">
          {preview}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("cancelReply")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Build the one-line preview text shown inside a reply quote. */
export function buildReplyPreview(message: Message, t: ReturnType<typeof useTranslations>): string {
  if (message.content_text) return message.content_text;
  switch (message.content_type) {
    case "image":
      return t("photo");
    case "video":
      return t("video");
    case "audio":
      return t("audio");
    case "document":
      return t("document");
    case "location":
      return t("location");
    case "template":
      return t("template");
    default:
      return t("message");
  }
}
