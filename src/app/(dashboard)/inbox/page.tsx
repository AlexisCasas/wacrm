"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useHandoffConversationGuard } from "@/hooks/use-handoff-conversation-guard";
import { useRoutingStageEvents } from "@/hooks/use-conversation-routing";
import {
  INBOX_CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import {
  applyMessageActivity,
  getConversationActivitySnapshot,
  getMessageActivitySnapshot,
  mergeConversationActivitySnapshot,
  mergeConversationUpdate,
  rollbackOptimisticMessageActivity,
  sortConversationsByActivity,
  type ConversationActivitySnapshot,
} from "@/lib/inbox/conversation-activity";
import type { Conversation, Message, Contact, ConversationStatus, Tag } from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { GlobalIncomingCallAlert } from "@/components/inbox/global-incoming-call-alert";
import { OperationalSidebar } from "@/components/inbox/operational-sidebar";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const tCalling = useTranslations("Inbox.calling");
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // This synchronous, activity-only mirror closes the gap between a
  // realtime setState call and its later React commit/effect. It is never a
  // second conversation store: only optimistic rollback snapshots read it.
  const latestActivityByConversationRef = useRef<
    Map<string, ConversationActivitySnapshot>
  >(new Map());
  const optimisticActivitySnapshotsRef = useRef<
    Map<string, ConversationActivitySnapshot | undefined>
  >(new Map());

  const markConversationRead = useCallback((conversationId: string) => {
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId && conversation.unread_count > 0
          ? { ...conversation, unread_count: 0 }
          : conversation,
      ),
    );
    setActiveConversation((prev) =>
      prev && prev.id === conversationId && prev.unread_count > 0
        ? { ...prev, unread_count: 0 }
        : prev,
    );

    const supabase = createClient();
    void supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to mark conversation as read:", error);
      });
  }, []);
  const rememberConversationActivity = useCallback((conversation: Conversation) => {
    const current = latestActivityByConversationRef.current.get(conversation.id);
    latestActivityByConversationRef.current.set(
      conversation.id,
      mergeConversationActivitySnapshot(
        current,
        getConversationActivitySnapshot(conversation),
      ),
    );
  }, []);
  const rememberMessageActivity = useCallback((message: Message) => {
    const current = latestActivityByConversationRef.current.get(
      message.conversation_id,
    );
    latestActivityByConversationRef.current.set(
      message.conversation_id,
      mergeConversationActivitySnapshot(current, getMessageActivitySnapshot(message)),
    );
  }, []);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * P3 — bumped ONLY when a brand-new tag DEFINITION is created
   * (ContactSidebar's "create tag" flow), never on assigning/removing
   * an existing tag, and never alongside `resyncToken`. Passed to
   * ConversationList so its independent tag-catalog fetch (for the
   * filter dropdown) refetches immediately instead of waiting for a
   * reconnect/visibility resync — see docs/P3_TAGS_INBOX_AUDIT.md
   * section N.
   */
  const [tagCatalogVersion, setTagCatalogVersion] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      // Inner-joined + blocked-filtered — a blocked contact's
      // conversation must never be re-inserted into the normal Inbox
      // list via this realtime self-heal path. A blocked match simply
      // resolves to no row (`data` null below), which the existing
      // `if (!data) return` already treats as "nothing to hydrate."
      const { data, error } = await supabase
        .from("conversations")
        .select(INBOX_CONVERSATION_SELECT)
        .eq("id", convId)
        .eq("contact.blocked", false)
        .maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) return;
      const fetched = normalizeConversation(data);
      rememberConversationActivity(fetched);
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return sortConversationsByActivity(
            prev.map((c) =>
              c.id === fetched.id
                ? { ...c, contact: c.contact ?? fetched.contact }
                : c,
            ),
          );
        }
        return sortConversationsByActivity([...prev, fetched]);
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, [rememberConversationActivity]);

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;

      if (!user) return;

      // whatsapp_config is one-row-per-account post-multi-user, so
      // the previous `.eq('user_id', user.id)` would miss the row
      // for any teammate who didn't personally save the config —
      // the "WhatsApp not connected" banner would show in the
      // shared inbox even though the admin had it configured.
      // Resolve account_id via the profile and query by that.
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
    };

    checkConnection();
  }, []);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        // Capture activity before enqueueing state so an immediately
        // following optimistic send cannot snapshot the pre-realtime value.
        rememberMessageActivity(newMsg);
        // Add to messages if it belongs to active conversation
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Replace optimistic message if it exists
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("temp-")
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Update conversation-list activity. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            applyMessageActivity(prev, newMsg, {
              // A sender's own message is never unread. This also prevents
              // a realtime confirmation of the agent's optimistic send from
              // changing the existing unread semantics.
              incrementUnread:
                newMsg.sender_type === "customer" &&
                activeConversation?.id !== newMsg.conversation_id,
            }),
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        // Update message status
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [activeConversation, hydrateConversation, rememberMessageActivity]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        rememberConversationActivity(conv);
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return sortConversationsByActivity([...prev, conv]);
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        // This monotonic mirror is deliberately updated before React queues
        // the row patch, closing the snapshot race with an immediate send.
        rememberConversationActivity(conv);
        if (knownConvIdsRef.current.has(conv.id)) {
          // Keep unread_count exactly as the server reports it, even for the
          // currently open thread. Viewing a conversation is not the same as
          // a human advisor replying to it.
          setConversations((prev) =>
            sortConversationsByActivity(
              prev.map((c) =>
                c.id === conv.id ? mergeConversationUpdate(c, conv) : c,
              ),
            ),
          );
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update the open conversation. A new unread message counts as
        // read only while a person is actually looking at this browser tab;
        // background/inactive tabs must never clear unread on their own.
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) =>
            prev ? mergeConversationUpdate(prev, conv) : prev
          );
          if (
            conv.unread_count > 0 &&
            document.visibilityState === "visible" &&
            document.hasFocus()
          ) {
            markConversationRead(conv.id);
          }
        }
      }
    },
    [activeConversation, hydrateConversation, markConversationRead, rememberConversationActivity]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(() => {
    const onReturnToInbox = () => {
      if (
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        setResyncToken((n) => n + 1);
        if (
          activeConversation?.unread_count &&
          activeConversation.unread_count > 0
        ) {
          markConversationRead(activeConversation.id);
        }
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onReturnToInbox();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onReturnToInbox);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onReturnToInbox);
    };
  }, [activeConversation, markConversationRead]);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      const ordered = sortConversationsByActivity(loaded);
      latestActivityByConversationRef.current.clear();
      for (const conversation of ordered) {
        latestActivityByConversationRef.current.set(
          conversation.id,
          getConversationActivitySnapshot(conversation),
        );
      }
      setConversations(ordered);
      // A reconnect/visibility/focus resync may be the first place we learn
      // that the already-open conversation became unread while the app was
      // backgrounded. If the user is now truly looking at WACRM, treat that
      // refreshed unread state as read.
      if (
        activeConversation &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        const refreshedActive = ordered.find(
          (conversation) => conversation.id === activeConversation.id,
        );
        if (refreshedActive && refreshedActive.unread_count > 0) {
          markConversationRead(refreshedActive.id);
        }
      }
      // Resolve a pending deep-link here rather than in an effect — this
      // is an event handler, so the setState calls below are allowed by
      // react-hooks/set-state-in-effect. Runs once per ?c=<id> URL value
      // via the ref, so realtime refreshes of the list can't snap the
      // user back to the deep-linked thread after they've navigated.
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        // If the deep-linked conversation is already the active one
        // (e.g. because the user clicked it in the list and we
        // router.replace()'d the URL, which made the ConversationList
        // refetch and land us back here), do NOT re-apply it. Doing so
        // would setMessages([]) on a thread whose messages have
        // already been loaded by MessageThread — and because
        // conversationId didn't change, MessageThread wouldn't
        // refetch. The thread would read "No messages yet" until a
        // full page reload rehydrated state from scratch.
        if (activeConversation?.id === deepLinkConvId) return;
        const match = ordered.find((c) => c.id === deepLinkConvId);
        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);
          // Landing on a deep-linked conversation is a human view when the
          // page is visible, so mark it read. Background hydration must not.
          if (
            match.unread_count > 0 &&
            document.visibilityState === "visible"
          ) {
            markConversationRead(match.id);
          }
        }
      }
    },
    [deepLinkConvId, activeConversation?.id, markConversationRead]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation is still a human
      // view. Mark it read before returning, but do not clear/reload its
      // messages.
      if (activeConversation?.id === conv.id) {
        if (conv.unread_count > 0) markConversationRead(conv.id);
        return;
      }
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      // An explicit user click is a real human view, so this conversation
      // becomes read immediately. Automated activity never calls this handler.
      if (conv.unread_count > 0) markConversationRead(conv.id);
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      router.replace(`/inbox?c=${conv.id}`, { scroll: false });
    },
    [activeConversation?.id, markConversationRead, router]
  );

  // The global ring banner stays mounted regardless of the selected thread.
  // Reuse normal selection, including its URL/unread handling; never call
  // Meta or claim the offer until the agent presses Accept in that thread.
  const handleOpenIncomingConversation = useCallback(async (conversationId: string) => {
    const loaded = conversations.find((candidate) => candidate.id === conversationId);
    if (loaded) {
      handleSelectConversation(loaded);
      return;
    }
    // A call can arrive from a conversation outside the list's current
    // search/page. Resolve through normal RLS and blocked-contact filtering.
    const supabase = createClient();
    const { data, error } = await supabase
      .from("conversations")
      .select(INBOX_CONVERSATION_SELECT)
      .eq("id", conversationId)
      .eq("contact.blocked", false)
      .maybeSingle();
    if (error || !data) {
      toast.error(tCalling("callNoLongerAvailable"));
      return;
    }
    const fetched = normalizeConversation(data);
    if (!fetched.contact) {
      toast.error(tCalling("callNoLongerAvailable"));
      return;
    }
    rememberConversationActivity(fetched);
    setConversations((prev) =>
      prev.some((candidate) => candidate.id === fetched.id)
        ? prev
        : sortConversationsByActivity([...prev, fetched])
    );
    handleSelectConversation(fetched);
  }, [conversations, handleSelectConversation, rememberConversationActivity, tCalling]);

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/inbox", { scroll: false });
  }, [router]);


  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    if (msg.id.startsWith("temp-")) {
      optimisticActivitySnapshotsRef.current.set(
        msg.id,
        latestActivityByConversationRef.current.get(msg.conversation_id),
      );
    }
    // The composer calls this before its network request. Keeping this
    // optimistic activity update beside the existing optimistic bubble means
    // the conversation rises immediately, while the later realtime INSERT is
    // an idempotent convergence step rather than a second send mechanism.
    // Its timestamp comes from the browser clock. Normally the persisted
    // message/conversation realtime rows supersede it; if a client's clock is
    // materially ahead, the monotonic guard intentionally keeps this value
    // until the existing reconnect/visibility/manual resync loads canonical
    // server activity rather than allowing an older event to move it back.
    rememberMessageActivity(msg);
    setConversations((prev) => applyMessageActivity(prev, msg));
  }, [rememberMessageActivity]);

  const handleMessageActivityFailed = useCallback((msg: Message) => {
    const snapshot = optimisticActivitySnapshotsRef.current.get(msg.id);
    optimisticActivitySnapshotsRef.current.delete(msg.id);
    if (!snapshot) return;

    const optimisticActivity = getMessageActivitySnapshot(msg);
    const currentActivity = latestActivityByConversationRef.current.get(
      msg.conversation_id,
    );
    if (
      currentActivity &&
      currentActivity.last_message_at === optimisticActivity.last_message_at &&
      currentActivity.last_message_text === optimisticActivity.last_message_text
    ) {
      latestActivityByConversationRef.current.set(msg.conversation_id, snapshot);
    }

    // The failed bubble retains its established `failed` status in the
    // thread; this only removes its unconfirmed preview/order from the list.
    setConversations((prev) =>
      rollbackOptimisticMessageActivity(prev, msg, snapshot),
    );
  }, []);

  const handleMessageActivityConfirmed = useCallback((tempMessageId: string) => {
    optimisticActivitySnapshotsRef.current.delete(tempMessageId);
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
    },
    [activeConversation]
  );

  /**
   * P3 — a tag was just assigned/removed/created for the contact
   * currently shown in ContactSidebar. Mirrors handleStatusChange /
   * handleAssignChange's shape: the write already succeeded server-side
   * (ContactSidebar only calls this AFTER a successful persist — see
   * its own tag-toggle handler), this just fans the new `tags` array
   * out to every piece of local state that embeds this contact, so
   * ConversationList's badges and its tag filter both see the change
   * immediately without a refetch. Matched by `contact.id`, not
   * `conversation.id` — ContactSidebar only knows the contact, and a
   * contact maps to exactly one conversation (P1) but this stays
   * correct even if that were ever not the case.
   */
  const handleContactTagsChange = useCallback(
    (contactId: string, tags: Tag[]) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.contact?.id === contactId
            ? { ...c, contact: { ...c.contact, tags } }
            : c
        )
      );
      setActiveContact((prev) =>
        prev && prev.id === contactId ? { ...prev, tags } : prev
      );
      setActiveConversation((prev) =>
        prev && prev.contact?.id === contactId
          ? { ...prev, contact: prev.contact ? { ...prev.contact, tags } : prev.contact }
          : prev
      );
    },
    []
  );

  /**
   * P3 — a brand-new tag DEFINITION was just created (never fired for
   * assigning/removing an existing one — see ContactSidebar's
   * `onTagCreated`). Bumps `tagCatalogVersion` so ConversationList's
   * filter dropdown picks it up immediately.
   */
  const handleTagCreated = useCallback(() => {
    setTagCatalogVersion((v) => v + 1);
  }, []);

  /** Keep the thread header, right sidebar and conversation list consistent
   * after a persisted standard-field edit (never optimistic). */
  const handleContactUpdated = useCallback((updated: Contact) => {
    setConversations((prev) => prev.map((conversation) =>
      conversation.contact?.id === updated.id
        ? { ...conversation, contact: { ...conversation.contact, ...updated } }
        : conversation
    ));
    setActiveContact((prev) =>
      prev?.id === updated.id ? { ...prev, ...updated } : prev
    );
    setActiveConversation((prev) =>
      prev?.contact?.id === updated.id
        ? { ...prev, contact: { ...prev.contact, ...updated } }
        : prev
    );
  }, []);

  /**
   * A contact was just blocked from this open conversation. The
   * conversation itself is never deleted (block/unblock never touches
   * `conversations`/`messages`), but it must leave the normal Inbox
   * list immediately rather than waiting for the next full refetch —
   * and the realtime self-heal (hydrateConversation) is already
   * filtered to never re-add a blocked contact's conversation, so this
   * removal sticks.
   */
  const handleContactBlocked = useCallback(
    (conversationId: string) => {
      latestActivityByConversationRef.current.delete(conversationId);
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversation?.id === conversationId) {
        handleCloseConversation();
      }
    },
    [activeConversation, handleCloseConversation]
  );

  // Comercial -> Logistica handoff: once the order is persisted, the conversation leaves the commercial Inbox immediately (see the hook).
  useHandoffConversationGuard(activeConversation?.id, handleContactBlocked);
  // Logistics -> shared: the routing row announces the chat to Comercial, so it appears in its list without F5 (hydrate is a no-op for chats it cannot see).
  useRoutingStageEvents(hydrateConversation);

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] min-h-0 flex-col overflow-hidden sm:-m-6 sm:h-[calc(100%+3rem)]">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">
            {t("whatsappNotConnected")}
          </p>
        </div>
      )}

      <GlobalIncomingCallAlert
        activeConversationId={activeConversation?.id ?? null}
        onOpenConversation={handleOpenIncomingConversation}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            tagCatalogVersion={tagCatalogVersion}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onMessageActivityFailed={handleMessageActivityFailed}
            onMessageActivityConfirmed={handleMessageActivityConfirmed}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onContactBlocked={handleContactBlocked}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <OperationalSidebar
              contact={activeContact}
              conversationId={activeConversation?.id ?? null}
              onTagsChanged={handleContactTagsChange}
              onTagCreated={handleTagCreated}
              onContactUpdated={handleContactUpdated}
            />
          </div>
        )}
      </div>
    </div>
  );
}
