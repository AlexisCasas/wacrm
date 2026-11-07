"use client";

import { useCallback, useSyncExternalStore } from "react";

import { createClient } from "@/lib/supabase/client";
import { FEP_PRICING_TYPE, fepWindowState, type FepWindowState } from "@/lib/whatsapp/fep-window";

export interface ContactAdOriginData {
  headline: string | null;
  body?: string | null;
  source_url: string | null;
}

/** The contact's Meta free-entry-point evidence (whatsapp_message_pricing), or null when Meta never confirmed one. */
interface FepRow {
  expiration_at: string | null;
}

export interface ContactFepState {
  contactId: string;
  ad: ContactAdOriginData | null;
  fep: FepRow | null;
}

const MINUTE_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Small module-level store shared by every component that shows the contact's Meta free-entry-point window (sidebar "ORIGEN DEL CLIENTE" and the thread header
 * badge): ONE read per contact while at least one of them is mounted, and ONE clock (`nowMs`, once a minute and at the expiry) so both always render the same
 * remaining time. An entry lives only while it has subscribers, so reopening a contact reads again and a previous contact's data is never returned.
 */
interface Entry { state: ContactFepState | null; subs: number; endTimer: ReturnType<typeof setTimeout> | null }

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let nowMs = Date.now();
let clock: ReturnType<typeof setInterval> | null = null;

function emit() { listeners.forEach((l) => l()); }
function tick() { nowMs = Date.now(); emit(); }

async function load(contactId: string, entry: Entry) {
  const supabase = createClient();
  try {
    const { data, error } = await supabase
      .from("contact_ad_attributions")
      .select("headline, body, source_url")
      .eq("contact_id", contactId)
      .maybeSingle();
    // A failed read says nothing about the origin: show nothing rather than claim there is none.
    if (error) return;
    const ad = (data as ContactAdOriginData | null) ?? null;
    let fep: FepRow | null = null;
    if (ad) {
      // Meta-confirmed window of this contact: the latest real expiration (rows without one come last); never summed or merged. A failed read just
      // leaves the window line out.
      try {
        const res = await supabase
          .from("whatsapp_message_pricing")
          .select("expiration_at")
          .eq("contact_id", contactId)
          .eq("pricing_type", FEP_PRICING_TYPE)
          .order("expiration_at", { ascending: false, nullsFirst: false })
          .limit(1);
        if (!res.error && Array.isArray(res.data) && res.data[0]) fep = { expiration_at: (res.data[0] as FepRow).expiration_at ?? null };
      } catch {
        /* no window line */
      }
    }
    if (entries.get(contactId) !== entry) return; // everyone unsubscribed meanwhile
    entry.state = { contactId, ad, fep };
    const end = fep?.expiration_at ? Date.parse(fep.expiration_at) : NaN;
    if (!Number.isNaN(end) && end > Date.now()) {
      entry.endTimer = setTimeout(tick, Math.min(end - Date.now() + 50, MAX_TIMEOUT_MS));
    }
    tick(); // the state was loaded later than `nowMs` was taken
  } catch {
    /* leave the section out */
  }
}

function subscribe(contactId: string | undefined, listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) clock = setInterval(tick, MINUTE_MS);
  let entry: Entry | undefined;
  if (contactId) {
    entry = entries.get(contactId);
    if (!entry) {
      entry = { state: null, subs: 0, endTimer: null };
      entries.set(contactId, entry);
      void load(contactId, entry);
    }
    entry.subs++;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && clock) { clearInterval(clock); clock = null; }
    if (contactId && entry && --entry.subs === 0) {
      if (entry.endTimer) clearTimeout(entry.endTimer);
      entries.delete(contactId);
    }
  };
}

/** Same Meta free-window state for every consumer of the same contact; `state` is null until loaded or when the read failed. */
export function useContactFepWindow(contactId: string | undefined): { state: ContactFepState | null; fepWindow: FepWindowState } {
  const sub = useCallback((l: () => void) => subscribe(contactId, l), [contactId]);
  const state = useSyncExternalStore(
    sub,
    () => (contactId ? entries.get(contactId)?.state ?? null : null),
    () => null,
  );
  const now = useSyncExternalStore(sub, () => nowMs, () => 0);
  const fepWindow: FepWindowState = state?.ad ? fepWindowState(state.fep, now) : { kind: "none" };
  return { state, fepWindow };
}
