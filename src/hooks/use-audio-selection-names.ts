"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

export interface SelectionName { id: string; name: string; active: boolean; in_use: number }
export interface SelectionNames {
  /** loading | ready | error (a list could not be read) | disabled (the account does not have the module) */
  state: "loading" | "ready" | "error" | "disabled";
  purposes: SelectionName[];
  identifiers: SelectionName[];
  /** Reads both lists again (after a change). */
  reload: () => void;
}

type Answer = { accountId: string | null; tick: number; state: SelectionNames["state"]; purposes: SelectionName[]; identifiers: SelectionName[] };

/**
 * The account's purposes and identifiers (migration 076) from /api/audio-guide: the account comes from the session, the module is gated by the
 * server. The answer is remembered WITH the account and the reload counter it was fetched for, so a different account never sees it and
 * "loading" needs no reset.
 */
export function useAudioSelectionNames(enabled = true): SelectionNames {
  const { accountId } = useAuth();
  const [tick, setTick] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const done = (state: SelectionNames["state"], purposes: SelectionName[] = [], identifiers: SelectionName[] = []) => { if (!cancelled) setAnswer({ accountId, tick, state, purposes, identifiers }); };
    (async () => {
      try {
        const [p, i] = await Promise.all([fetch("/api/audio-guide/purposes"), fetch("/api/audio-guide/identifiers")]);
        const [pb, ib] = await Promise.all([p.json().catch(() => ({})), i.json().catch(() => ({}))]) as [{ purposes?: SelectionName[]; error?: string }, { identifiers?: SelectionName[]; error?: string }];
        if ((p.status === 403 && pb.error === "voice_notes_disabled") || (i.status === 403 && ib.error === "voice_notes_disabled")) return done("disabled");
        if (!p.ok || !i.ok) return done("error");
        done("ready", pb.purposes ?? [], ib.identifiers ?? []);
      } catch {
        done("error");
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, accountId, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const fresh = enabled && answer && answer.accountId === accountId && answer.tick === tick ? answer : null;
  // While a reload is in flight keep showing the previous lists of the same account instead of flashing "loading".
  const stale = enabled && !fresh && answer && answer.accountId === accountId ? answer : null;
  const shown = fresh ?? stale;
  return { state: shown ? shown.state : "loading", purposes: shown?.purposes ?? [], identifiers: shown?.identifiers ?? [], reload };
}
