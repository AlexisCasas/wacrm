"use client";

import { contactLabel } from "@/lib/contacts/display";
import {
  matchesInboxSearch,
  orderPhoneCandidates,
  pickOrderContactIds,
  planInboxSearch,
} from "@/lib/inbox/search-query";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  INBOX_CONVERSATION_SELECT,
  matchesContactFilters,
  needsHumanAttention,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { sortConversationsByActivity } from "@/lib/inbox/conversation-activity";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X, Hand } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { useDateFnsLocale } from "@/lib/date-locale";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { startSearchTimer } from "@/lib/perf/search-timing";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Increment ONLY when a new tag DEFINITION is created elsewhere
   * (ContactSidebar's "create tag" flow) — never on assigning/removing
   * an existing tag, and never on `resyncToken` — to refetch just the
   * tag catalog below without touching `conversations`. A brand-new
   * tag must appear in the filter dropdown immediately, without
   * waiting for a reconnect/visibility resync. Optional so existing
   * callers keep working (defaults to a stable 0 — fetch once).
   */
  tagCatalogVersion?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread" | "needs_human";

// Wait for the user to pause typing before hitting the database: a 10-digit
// phone number used to fire ten searches (SEARCH-01).
const SEARCH_DEBOUNCE_MS = 300;

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  tagCatalogVersion = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterNeedsHuman"), value: "needs_human" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  // The term the database search and the in-memory filter actually use.
  const appliedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // A failed load/search is shown (with a retry) instead of silently keeping
  // the previous list. `retryToken` re-runs the fetch effect on demand.
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // FIX 02: conversations found ONLY through the phone of an order (BSUID
  // contacts have no phone of their own), and whether more matches exist
  // than were expanded. Both are per-search results.
  const [orderOnlyIds, setOrderOnlyIds] = useState<ReadonlySet<string>>(new Set());
  const [orderTruncated, setOrderTruncated] = useState(false);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    // Cancels this run's in-flight requests when a newer search/resync
    // supersedes it (or the list unmounts), instead of letting the server
    // keep working on a result nobody will read.
    const controller = new AbortController();

    (async () => {
      const term = appliedSearch.trim();
      const finishTimer = startSearchTimer("inbox", term.length);
      let requests = 0;
      const baseQuery = () =>
        supabase
          .from("conversations")
          .select(INBOX_CONVERSATION_SELECT)
          .eq("contact.blocked", false)
          .order("last_message_at", { ascending: false })
          .order("id", { ascending: true })
          .abortSignal(controller.signal);

      type InboxRows = Parameters<typeof normalizeConversations>[0];
      type InboxQueryError = {
        message: string;
        details?: string | null;
        hint?: string | null;
        code?: string | null;
      };
      let data: InboxRows | null = null;
      let error: InboxQueryError | null = null;
      let orderOnly: ReadonlySet<string> = new Set();
      let truncated = false;

      if (!term) {
        requests++;
        ({ data, error } = await baseQuery());
      } else {
        // PostgREST caps an un-ranged response (commonly at 1,000 rows).
        // Search in the database instead of filtering the already-capped
        // Inbox load, and page each branch so a matching conversation cannot
        // disappear merely because it falls after that cap.
        const PAGE_SIZE = 1_000;
        const fetchAll = async (query: ReturnType<typeof baseQuery>) => {
          const rows: InboxRows = [];
          for (let from = 0; ; from += PAGE_SIZE) {
            requests++;
            const { data: page, error: pageError } = await query.range(
              from,
              from + PAGE_SIZE - 1,
            );
            if (pageError) throw pageError;
            rows.push(...(page ?? []));
            if ((page?.length ?? 0) < PAGE_SIZE) return rows;
          }
        };

        // The plan normalizes phones (+51, spaces, dashes, parentheses) and
        // escapes every PostgREST/LIKE special character in the term.
        const plan = planInboxSearch(term);
        try {
          // PostgREST cannot OR predicates from an embedded table and the
          // parent table in one expression. Keep the pre-existing criteria
          // by querying each side and de-duplicating conversations below.
          // FIX 02: a BSUID-only contact has no phone, but its orders do.
          // Only for a COMPLETE number: order -> contact_id -> conversation
          // (never order.conversation_id, which can be stale). RLS applies to
          // both tables as the signed-in user; a failure here fails the whole
          // search (no partial result is shown as definitive).
          const ORDER_PAGE = 1_000;
          const orderPhones = orderPhoneCandidates(plan);
          const fetchOrderMatches = async () => {
            if (orderPhones.length === 0) {
              return { rows: [] as InboxRows, truncated: false };
            }
            requests++;
            const { data: orders, error: orderError } = await supabase
              .from("order_confirmations")
              .select("contact_id")
              .in("phone", orderPhones)
              .not("contact_id", "is", null)
              .order("confirmed_at", { ascending: false })
              .abortSignal(controller.signal)
              .range(0, ORDER_PAGE - 1);
            if (orderError) throw orderError;
            const picked = pickOrderContactIds(
              (orders ?? []) as { contact_id: string | null }[],
              ORDER_PAGE,
            );
            if (picked.contactIds.length === 0) {
              return { rows: [] as InboxRows, truncated: picked.truncated };
            }
            return {
              rows: await fetchAll(baseQuery().in("contact_id", picked.contactIds)),
              truncated: picked.truncated,
            };
          };

          const [contactMatches, messageMatches, orderMatches] = await Promise.all([
            fetchAll(
              baseQuery().or(plan.contactOrFilter, {
                referencedTable: "contact",
              }),
            ),
            fetchAll(baseQuery().ilike("last_message_text", plan.likePattern)),
            fetchOrderMatches(),
          ]);
          const unique = new Map<string, (typeof contactMatches)[number]>();
          for (const conversation of [...contactMatches, ...messageMatches]) {
            unique.set(conversation.id, conversation);
          }
          const onlyByOrder = new Set<string>();
          for (const conversation of orderMatches.rows) {
            if (!unique.has(conversation.id)) {
              unique.set(conversation.id, conversation);
              onlyByOrder.add(conversation.id);
            }
          }
          orderOnly = onlyByOrder;
          truncated = orderMatches.truncated;
          data = Array.from(unique.values());
        } catch (searchError) {
          error = {
            message:
              searchError instanceof Error
                ? searchError.message
                : "Failed to search conversations",
          };
        }
      }

      if (cancelled) {
        finishTimer({ requests, aborted: true });
        return;
      }

      if (error) {
        finishTimer({ requests, failed: true });
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoadError(true);
        setLoading(false);
        return;
      }

      finishTimer({ requests, rows: data?.length ?? 0 });
      setLoadError(false);
      setOrderOnlyIds(orderOnly);
      setOrderTruncated(truncated);
      onConversationsLoadedRef.current(
        sortConversationsByActivity(normalizeConversations(data ?? [])),
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken, appliedSearch, retryToken]);

  // Tag definitions for the filter picker — loaded once (labels/colours
  // stay stable regardless of which conversations happen to be loaded),
  // and again whenever `tagCatalogVersion` bumps (a NEW tag definition
  // was created elsewhere — see the prop doc above). Assigning/removing
  // an existing tag never touches this dependency, so it never
  // refetches for that.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [tagCatalogVersion]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "needs_human") {
      result = result.filter((c) => needsHumanAttention(c));
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (appliedSearch.trim()) {
      // Same normalization as the database query, so a phone typed as
      // "+51 987-654-321" is not filtered out again here.
      const plan = planInboxSearch(appliedSearch);
      result = result.filter((c) => matchesInboxSearch(c, plan, orderOnlyIds));
    }

    return result;
  }, [conversations, filter, appliedSearch, selectedTagIds, selectedCompany, orderOnlyIds]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 px-4 py-12 text-center"
          >
            <p className="text-sm text-destructive">{t("loadError")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoadError(false);
                setRetryToken((n) => n + 1);
              }}
            >
              {t("retry")}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {orderTruncated && appliedSearch.trim() && (
              <p
                role="status"
                className="border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
              >
                {t("orderMatchesTruncated")}
              </p>
            )}
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                matchedByOrder={orderOnlyIds.has(conv.id)}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  /** Found only through the phone of one of its orders (FIX 02). */
  matchedByOrder?: boolean;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  matchedByOrder = false,
  isActive,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contactLabel(contact, t("unknown"));
  const initials = displayName.charAt(0).toUpperCase();
  const dateFnsLocale = useDateFnsLocale();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: dateFnsLocale,
      })
    : "";

  // Compact badges (P3) — `contact.tags` is already embedded by
  // INBOX_CONVERSATION_SELECT's join (src/lib/inbox/conversations.ts);
  // this is pure presentation over data already in memory, never a
  // new query per row. Max 2 chips shown at this card width; the rest
  // collapse into a single "+N" chip rather than wrapping the row
  // onto a third/fourth line.
  const visibleTags = contact?.tags?.slice(0, 2) ?? [];
  const hiddenTagCount = (contact?.tags?.length ?? 0) - visibleTags.length;

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {needsHumanAttention(conversation) && (
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
                title={t("needsHumanAttention")}
              >
                <Hand className="h-2.5 w-2.5" />
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
          </div>
        </div>
        {matchedByOrder && (
          <span
            className="mt-1 inline-block rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:text-sky-400"
            title={t("matchedByOrderHint")}
          >
            {t("matchedByOrder")}
          </span>
        )}
        {visibleTags.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            {visibleTags.map((tag) => (
              <span
                key={tag.id}
                className="max-w-16 truncate rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                title={tag.name}
              >
                {tag.name}
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                title={contact?.tags?.slice(2).map((t) => t.name).join(", ")}
              >
                +{hiddenTagCount}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
