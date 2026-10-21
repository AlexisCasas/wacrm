"use client";

import { useEffect, useState } from "react";

/**
 * Whether the server enabled voice notes ("Audios por producto") for this account (GET /api/flows/voice-notes). Fail-closed: `false`
 * until the server says yes, and `null` while it has not answered. Hiding the menu entry is a convenience; every API route checks again.
 */
let cached: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  cached ??= fetch("/api/flows/voice-notes")
    .then(async (response) => (response.ok ? ((await response.json()) as { enabled?: boolean }).enabled === true : false))
    .catch(() => false)
    .then((enabled) => {
      if (!enabled) cached = null; // a transient failure must not stick for the whole session
      return enabled;
    });
  return cached;
}

export function useAudioGuideEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load().then((value) => { if (!cancelled) setEnabled(value); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}
