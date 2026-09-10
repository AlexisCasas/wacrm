"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Search,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { useDateFnsLocale } from "@/lib/date-locale";
import {
  addContactTag,
  deleteContactTag,
  createTag as createTagApi,
  TagApiError,
} from "@/lib/contacts/tag-api";
import { PRESET_TAG_COLORS } from "@/lib/contacts/tag-colors";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
  /**
   * Fired after a tag assign/remove/create has ALREADY persisted
   * successfully — never optimistically. The Inbox page (the only
   * current caller) uses this to patch `conversations`/`activeContact`/
   * `activeConversation` so ConversationList's badges and its tag
   * filter stay consistent without a refetch. See
   * docs/P3_TAGS_INBOX_AUDIT.md sections M/N.
   */
  onTagsChanged?: (contactId: string, tags: Tag[]) => void;
  /**
   * Fired once a brand-new tag DEFINITION has been persisted (never on
   * assigning/removing an existing one). The Inbox page uses this to
   * bump ConversationList's tag-catalog fetch so the new tag appears
   * in the filter dropdown immediately, without waiting for a
   * reconnect/visibility resync. See docs/P3_TAGS_INBOX_AUDIT.md
   * section N (immediate filter availability).
   */
  onTagCreated?: (tag: Tag) => void;
}

export function ContactSidebar({ contact, onTagsChanged, onTagCreated }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");
  const dateFnsLocale = useDateFnsLocale();

  const { accountId, canSendMessages, canEditSettings } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Tag catalog for the account — NOT the contact's own tags (those
  // come from `contact.tags`, already embedded by the Inbox's
  // conversation query; no separate fetch for them, no N+1). Loaded
  // once per account, independent of which contact is selected.
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_TAG_COLORS[0].value);
  const [creatingTag, setCreatingTag] = useState(false);

  const contactTags = useMemo(() => contact?.tags ?? [], [contact?.tags]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Deals and notes only — tags come from the `contact` prop.
    const [dealsRes, notesRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
  }, [contact]);

  // Load on contact change. setDeals/setNotes run inside an async
  // Supabase callback, not synchronously in the effect body.
  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  // Tag catalog — loaded once per account (not per contact). Every
  // account member can read `tags` (viewer+), so this never 403s for
  // a role that can only view tags.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data } = await supabase
        .from("tags")
        .select("*")
        .order("name");
      if (!cancelled && data) setAllTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Reset picker-local UI (search/create form) whenever the active
  // contact changes, so switching Contact A -> B never carries over a
  // half-typed search or an open create form for the wrong contact.
  useEffect(() => {
    setPickerOpen(false);
    setTagSearch("");
    setShowCreateForm(false);
    setNewTagName("");
    setTogglingTagId(null);
  }, [contact?.id]);

  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTags, tagSearch]);

  const canAssignTags = canSendMessages; // agent+, per the audited permission matrix
  const canCreateTags = canEditSettings; // admin+, per the audited permission matrix

  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact || togglingTagId) return;
      const isAssigned = contactTags.some((t) => t.id === tag.id);
      setTogglingTagId(tag.id);
      try {
        if (isAssigned) {
          await deleteContactTag(contact.id, tag.id);
          onTagsChanged?.(
            contact.id,
            contactTags.filter((t) => t.id !== tag.id),
          );
        } else {
          await addContactTag(contact.id, tag.id);
          onTagsChanged?.(contact.id, [...contactTags, tag]);
        }
      } catch {
        toast.error(
          isAssigned ? tSidebar("errorRemoveTag") : tSidebar("errorAssignTag"),
        );
      } finally {
        setTogglingTagId(null);
      }
    },
    [contact, contactTags, togglingTagId, onTagsChanged, tSidebar],
  );

  const handleCreateTag = useCallback(async () => {
    if (!contact || creatingTag) return;
    const name = newTagName.trim();
    if (!name) {
      toast.error(tSidebar("errorNameRequired"));
      return;
    }

    setCreatingTag(true);
    let created;
    try {
      created = await createTagApi(name, newTagColor);
      setAllTags((prev) => [...prev, created!]);
      // Fired regardless of whether the assignment below succeeds —
      // the DEFINITION exists now either way, so the account-wide
      // filter catalog (ConversationList) must know about it.
      onTagCreated?.(created);
    } catch (err) {
      const code = err instanceof TagApiError ? err.code : undefined;
      const message =
        code === "name_required"
          ? tSidebar("errorNameRequired")
          : code === "name_too_long"
            ? tSidebar("errorNameTooLong", { max: 40 })
            : code === "invalid_color"
              ? tSidebar("errorInvalidColor")
              : code === "tag_name_conflict"
                ? tSidebar("errorDuplicateTag")
                : tSidebar("errorCreateTag");
      toast.error(message);
      setCreatingTag(false);
      return;
    }

    try {
      await addContactTag(contact.id, created.id);
      onTagsChanged?.(contact.id, [...contactTags, created]);
      toast.success(tSidebar("toastTagCreated"));
      setNewTagName("");
      setShowCreateForm(false);
    } catch {
      // The tag DOES exist now (already merged into allTags above) —
      // only assigning it to THIS contact failed. Never claim the
      // whole operation failed; it's still selectable from the list.
      toast.error(tSidebar("errorAssignAfterCreate"));
    } finally {
      setCreatingTag(false);
    }
  }, [contact, contactTags, creatingTag, newTagName, newTagColor, onTagsChanged, onTagCreated, tSidebar]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                {tSidebar("tags")}
              </div>
              {canAssignTags && (
                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger
                    aria-label={tSidebar("addTagAria")}
                    className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="p-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={tagSearch}
                        onChange={(e) => setTagSearch(e.target.value)}
                        placeholder={tSidebar("tagsSearchPlaceholder")}
                        autoFocus
                        className="h-8 pl-7 text-xs"
                      />
                    </div>

                    <div className="mt-2 max-h-52 overflow-y-auto">
                      {allTags.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground">
                          {tSidebar("tagsCatalogEmpty")}
                        </p>
                      ) : filteredTags.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground">
                          {tSidebar("tagsNoResults")}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {filteredTags.map((tag) => {
                            const assigned = contactTags.some((t) => t.id === tag.id);
                            const busy = togglingTagId === tag.id;
                            return (
                              <button
                                key={tag.id}
                                type="button"
                                onClick={() => handleToggleTag(tag)}
                                disabled={busy}
                                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <Checkbox checked={assigned} readOnly className="pointer-events-none" />
                                <span
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: tag.color }}
                                />
                                <span className="flex-1 truncate text-foreground">{tag.name}</span>
                                {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {canCreateTags && (
                      <div className="mt-2 border-t border-border pt-2">
                        {showCreateForm ? (
                          <div className="flex flex-col gap-2">
                            <Input
                              value={newTagName}
                              onChange={(e) => setNewTagName(e.target.value)}
                              placeholder={tSidebar("createTagNamePlaceholder")}
                              maxLength={40}
                              disabled={creatingTag}
                              autoFocus
                              className="h-8 text-xs"
                            />
                            <div className="flex flex-wrap gap-1">
                              {PRESET_TAG_COLORS.map((c) => (
                                <button
                                  key={c.value}
                                  type="button"
                                  onClick={() => setNewTagColor(c.value)}
                                  aria-label={c.name}
                                  aria-pressed={newTagColor === c.value}
                                  disabled={creatingTag}
                                  className={cn(
                                    "size-5 rounded-md transition-transform hover:scale-110",
                                    newTagColor === c.value &&
                                      "outline outline-2 outline-offset-2 outline-primary",
                                  )}
                                  style={{ backgroundColor: c.value }}
                                />
                              ))}
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  setShowCreateForm(false);
                                  setNewTagName("");
                                }}
                                disabled={creatingTag}
                              >
                                {tSidebar("createTagCancel")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={handleCreateTag}
                                disabled={creatingTag || !newTagName.trim()}
                              >
                                {creatingTag && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                {tSidebar("createTagSave")}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowCreateForm(true)}
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs text-primary hover:bg-muted"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {tSidebar("createTagButton")}
                          </button>
                        )}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {contactTags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                contactTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    {canAssignTags && (
                      <button
                        type="button"
                        onClick={() => handleToggleTag(tag)}
                        disabled={togglingTagId === tag.id}
                        aria-label={tSidebar("removeTagAria", { name: tag.name })}
                        className="rounded-full opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
                      >
                        {togglingTagId === tag.id ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <X className="h-2.5 w-2.5" />
                        )}
                      </button>
                    )}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm", { locale: dateFnsLocale })}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
