"use client";

import { useEffect, useState } from "react";

/**
 * Client view of the server-enforced subflow-authoring pilot flag (GET /api/flows/capabilities). Fail-closed: the
 * "Run another flow" node is only offered once the server said yes. Hiding it is a convenience; the API and
 * migration 068 enforce the rules independently.
 */
let cached: Promise<boolean> | null = null;

function loadSubflowAuthoring(): Promise<boolean> {
  cached ??= fetch("/api/flows/capabilities")
    .then(async (response) => (response.ok ? ((await response.json()) as { subflowAuthoring?: boolean }).subflowAuthoring === true : false))
    .catch(() => false)
    .then((enabled) => {
      if (!enabled) cached = null; // a transient failure must not stick for the whole session
      return enabled;
    });
  return cached;
}

export function useSubflowAuthoringCapability(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSubflowAuthoring().then((value) => { if (!cancelled) setEnabled(value); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

/** Test seam: forget the cached answer. */
export function resetSubflowAuthoringCache(): void {
  cached = null;
}
