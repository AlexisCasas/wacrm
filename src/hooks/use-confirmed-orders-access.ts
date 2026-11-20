"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

/**
 * Whether the CURRENT user may open "Pedidos confirmados" (GET /api/orders/confirmed/access): the account has logistics_mvp_enabled AND the user has
 * an operational area (supervisor / logistics / commercial). Fail-closed: `false` for any error or non-yes answer, `null` while unknown.
 * The answer belongs to one account AND one user, so it is never reused after signing in as someone else. Hiding the menu is a convenience; the
 * list endpoint enforces the same rules again.
 */
export function useConfirmedOrdersAccess(): boolean | null {
  const { user, accountId } = useAuth();
  const key = user?.id && accountId ? `${accountId}:${user.id}` : null;
  const [answer, setAnswer] = useState<{ key: string; allowed: boolean } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void (async () => {
      let allowed = false;
      try {
        const res = await fetch("/api/orders/confirmed/access", { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { allowed?: unknown };
          allowed = body.allowed === true;
        }
      } catch {
        allowed = false;
      }
      if (!cancelled) setAnswer({ key, allowed });
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return key && answer?.key === key ? answer.allowed : null;
}
