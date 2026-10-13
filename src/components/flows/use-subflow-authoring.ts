"use client";

import { useEffect, useState } from "react";

/**
 * Client view of the server-enforced per-account authoring flags (GET /api/flows/capabilities): "Run another flow" nodes
 * and durable waits. Fail-closed: an option is only offered once the server said yes. Hiding it is a convenience; the
 * API and the database enforce the rules independently.
 */
interface AuthoringCapabilities { subflowAuthoring: boolean; durableWaitAuthoring: boolean; customerReplyCondition: boolean }
let cached: Promise<AuthoringCapabilities> | null = null;

function loadCapabilities(): Promise<AuthoringCapabilities> {
  cached ??= Promise.resolve().then(() => fetch("/api/flows/capabilities"))
    .then(async (response) => {
      if (!response.ok) return { subflowAuthoring: false, durableWaitAuthoring: false, customerReplyCondition: false };
      const data = (await response.json()) as { subflowAuthoring?: boolean; durableWaitAuthoring?: boolean; customerReplyCondition?: boolean };
      return { subflowAuthoring: data.subflowAuthoring === true, durableWaitAuthoring: data.durableWaitAuthoring === true, customerReplyCondition: data.customerReplyCondition === true };
    })
    .catch(() => ({ subflowAuthoring: false, durableWaitAuthoring: false, customerReplyCondition: false }))
    .then((caps) => {
      if (!caps.subflowAuthoring && !caps.durableWaitAuthoring && !caps.customerReplyCondition) cached = null; // a transient failure must not stick for the whole session
      return caps;
    });
  return cached;
}

function useCapability(key: keyof AuthoringCapabilities): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadCapabilities().then((caps) => { if (!cancelled) setEnabled(caps[key]); });
    return () => { cancelled = true; };
  }, [key]);
  return enabled;
}

export const useSubflowAuthoringCapability = () => useCapability("subflowAuthoring");
export const useDurableWaitAuthoringCapability = () => useCapability("durableWaitAuthoring");
export const useCustomerReplyConditionCapability = () => useCapability("customerReplyCondition");

/** Test seam: forget the cached answer. */
export function resetSubflowAuthoringCache(): void {
  cached = null;
}
