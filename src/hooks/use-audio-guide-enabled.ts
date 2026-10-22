"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

/**
 * What the server enabled for the CURRENT account (GET /api/flows/voice-notes). Two independent capabilities:
 *   - `enabled`: Audio inside the Multimedia node;
 *   - `productAudios`: the specialised "Audios por producto" module (menu entry, /audio-guide, the product-audios node).
 * Fail-closed: both are `false` until the server says yes (a response without `product_audios` counts as no), and the hook returns `null`
 * while it does not know yet. Hiding a menu entry is a convenience; every API route checks its own gate again.
 *
 * The answer belongs to ONE account: it is cached per account id (never for the whole page), so signing in as someone else in the same
 * browser session cannot reuse another account's answer, and nothing is requested until the account is known.
 */
export interface VoiceNoteCapabilities {
  enabled: boolean;
  productAudios: boolean;
}

const cache = new Map<string, Promise<VoiceNoteCapabilities | null>>();

async function fetchCapabilities(): Promise<VoiceNoteCapabilities | null> {
  try {
    const response = await fetch("/api/flows/voice-notes");
    if (!response.ok) return null;
    const body = (await response.json()) as { enabled?: unknown; product_audios?: unknown };
    return { enabled: body.enabled === true, productAudios: body.product_audios === true };
  } catch {
    return null;
  }
}

function load(accountId: string): Promise<VoiceNoteCapabilities | null> {
  let pending = cache.get(accountId);
  if (!pending) {
    pending = fetchCapabilities().then((value) => {
      // Only a full "yes" is remembered: a transient failure, or an account that later gets enabled, must not stick for the session.
      if (!value || !value.productAudios) cache.delete(accountId);
      return value;
    });
    cache.set(accountId, pending);
  }
  return pending;
}

/** Test hook: forget every remembered answer. */
export function resetVoiceNoteCapabilityCache(): void {
  cache.clear();
}

export function useVoiceNoteCapabilities(): VoiceNoteCapabilities | null {
  const { accountId } = useAuth();
  const [answer, setAnswer] = useState<{ accountId: string; value: VoiceNoteCapabilities } | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void load(accountId).then((value) => {
      if (!cancelled) setAnswer({ accountId, value: value ?? { enabled: false, productAudios: false } });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  // An answer fetched for another account is never shown for this one.
  return accountId && answer?.accountId === accountId ? answer.value : null;
}

/** Whether the specialised "Audios por producto" module is enabled for this account (`null` while unknown). */
export function useAudioGuideEnabled(): boolean | null {
  const capabilities = useVoiceNoteCapabilities();
  return capabilities === null ? null : capabilities.productAudios;
}
