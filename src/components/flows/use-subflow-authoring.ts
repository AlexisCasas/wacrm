"use client";

import { useEffect, useState } from "react";

/**
 * Client view of the server-enforced per-account authoring flags (GET /api/flows/capabilities): "Run another flow" nodes
 * and durable waits. Fail-closed: an option is only offered once the server said yes. Hiding it is a convenience; the
 * API and the database enforce the rules independently.
 */
interface AuthoringCapabilities { subflowAuthoring: boolean; durableWaitAuthoring: boolean; customerReplyCondition: boolean; subflowExecution: boolean; durableWaitExecution: boolean }
const NONE: AuthoringCapabilities = { subflowAuthoring: false, durableWaitAuthoring: false, customerReplyCondition: false, subflowExecution: false, durableWaitExecution: false };
let cached: Promise<AuthoringCapabilities> | null = null;

function loadCapabilities(): Promise<AuthoringCapabilities> {
  cached ??= Promise.resolve().then(() => fetch("/api/flows/capabilities"))
    .then(async (response) => {
      if (!response.ok) return NONE;
      const data = (await response.json()) as Partial<AuthoringCapabilities>;
      return { subflowAuthoring: data.subflowAuthoring === true, durableWaitAuthoring: data.durableWaitAuthoring === true, customerReplyCondition: data.customerReplyCondition === true, subflowExecution: data.subflowExecution === true, durableWaitExecution: data.durableWaitExecution === true };
    })
    .catch(() => NONE)
    .then((caps) => {
      if (!caps.subflowAuthoring && !caps.durableWaitAuthoring && !caps.customerReplyCondition && !caps.subflowExecution && !caps.durableWaitExecution) cached = null; // a transient failure must not stick for the whole session
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

/**
 * Can this account actually RUN connected flows / durable waits (environment AND database)? `loaded` is false until the server
 * answered, so the editor never claims "not enabled" before it knows.
 */
export function useExecutionStatus(): { loaded: boolean; subflowExecution: boolean; durableWaitExecution: boolean } {
  const [state, setState] = useState({ loaded: false, subflowExecution: false, durableWaitExecution: false });
  useEffect(() => {
    let cancelled = false;
    void loadCapabilities().then((caps) => { if (!cancelled) setState({ loaded: true, subflowExecution: caps.subflowExecution, durableWaitExecution: caps.durableWaitExecution }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}
