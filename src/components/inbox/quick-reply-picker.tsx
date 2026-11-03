"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquare, Search, X, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function previewText(qr: QuickReply): string {
  return qr.kind === "interactive" && qr.interactive_payload
    ? interactivePayloadPreviewText(qr.interactive_payload)
    : (qr.content_text ?? "");
}

/**
 * Case-, accent- and extra-whitespace-insensitive partial match on title
 * and message text. Keeps the original order; an empty query returns all.
 */
export function filterQuickReplies(
  items: QuickReply[],
  query: string,
): QuickReply[] {
  const needle = normalizeSearch(query);
  if (!needle) return items;
  return items.filter((qr) =>
    normalizeSearch(`${qr.title} ${previewText(qr)}`).includes(needle),
  );
}

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

/**
 * Lists the account's saved quick replies for insertion into the
 * composer. Text snippets fill the textarea; interactive snippets open
 * the builder pre-filled (handled by the caller's `onPick`).
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const filtered = useMemo(
    () => filterQuickReplies(items, query),
    [items, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(-1);
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setItems((data.quick_replies as QuickReply[]) ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quickReplies")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && filtered.length > 0) {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % filtered.length);
              } else if (e.key === "ArrowUp" && filtered.length > 0) {
                e.preventDefault();
                setActiveIndex((i) =>
                  i <= 0 ? filtered.length - 1 : i - 1,
                );
              } else if (e.key === "Enter" && filtered[activeIndex]) {
                e.preventDefault();
                onPick(filtered[activeIndex]);
              }
            }}
            placeholder={t("quickRepliesSearchPlaceholder")}
            aria-label={t("quickRepliesSearchPlaceholder")}
            className="px-8"
            autoFocus
          />
          {query && (
            <button
              type="button"
              aria-label={t("quickRepliesClearSearch")}
              onClick={() => {
                setQuery("");
                setActiveIndex(-1);
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("quickRepliesEmpty")}
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("quickRepliesNoMatches")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((qr, index) => (
                <li key={qr.id}>
                  <button
                    type="button"
                    onClick={() => onPick(qr)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-left hover:border-primary/50 hover:bg-muted",
                      index === activeIndex && "border-primary/50 bg-muted",
                    )}
                  >
                    {qr.kind === "interactive" ? (
                      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {qr.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {previewText(qr)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
