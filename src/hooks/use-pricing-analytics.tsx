'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { PricingAnalyticsResult } from '@/lib/whatsapp/pricing-analytics';

type UnavailableReason = 'no_config' | 'missing_waba' | 'token_invalid';

type ApiResponse =
  | ({ status: 'ready' } & PricingAnalyticsResult)
  | { status: 'unavailable'; reason: UnavailableReason };

export type PricingAnalyticsState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PricingAnalyticsResult }
  | { kind: 'unavailable'; reason: UnavailableReason }
  | { kind: 'error' };

interface PricingAnalyticsContextValue {
  state: PricingAnalyticsState;
  retry: () => void;
}

interface StoredState {
  accountKey: string | null;
  value: PricingAnalyticsState;
}

const LOADING_STATE = { kind: 'loading' } as const;

/** Meta recalculates analytics after the fact, so the Panel re-reads them while it stays open. */
export const PRICING_ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
/** A request that never answers must not block every later refresh. */
const REQUEST_TIMEOUT_MS = 60 * 1000;

const PricingAnalyticsContext =
  createContext<PricingAnalyticsContextValue | null>(null);

export function PricingAnalyticsProvider({
  enabled,
  accountKey,
  children,
  refreshIntervalMs = PRICING_ANALYTICS_REFRESH_MS,
}: {
  enabled: boolean;
  accountKey: string;
  children: ReactNode;
  refreshIntervalMs?: number;
}) {
  const [stored, setStored] = useState<StoredState>({
    accountKey: null,
    value: LOADING_STATE,
  });
  const [requestKey, setRequestKey] = useState(0);

  // One cycle = ONE request whose result feeds every consumer (header indicator and Panel widget). It runs immediately when the Panel opens
  // (or the account / retry key changes), then every refreshIntervalMs while `enabled`. The cleanup stops the timer and aborts the request.
  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;

    const load = async () => {
      // Never start a second request while the previous one is still running.
      if (inFlight) return;
      inFlight = true;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch('/api/whatsapp/pricing-analytics', {
          headers: { Accept: 'application/json' },
          signal: request.signal,
        });
        if (!response.ok) throw new Error('pricing analytics unavailable');
        const body = (await response.json()) as ApiResponse;
        if (!active) return;
        if (body.status === 'ready') {
          const { status: _status, ...data } = body;
          void _status;
          setStored({ accountKey, value: { kind: 'ready', data } });
        } else {
          setStored({
            accountKey,
            value: { kind: 'unavailable', reason: body.reason },
          });
        }
      } catch {
        if (!active) return;
        // A transient failure during a refresh keeps the last valid numbers on screen; the next cycle simply tries again.
        setStored((previous) =>
          previous.accountKey === accountKey && previous.value.kind === 'ready'
            ? previous
            : { accountKey, value: { kind: 'error' } }
        );
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    };

    void load();
    const timer = setInterval(() => void load(), refreshIntervalMs);

    return () => {
      active = false;
      clearInterval(timer);
      controller?.abort();
    };
  }, [accountKey, enabled, refreshIntervalMs, requestKey]);

  const retry = useCallback(() => {
    setStored({ accountKey, value: LOADING_STATE });
    setRequestKey((value) => value + 1);
  }, [accountKey]);

  // Never expose the previous account's snapshot during an account switch.
  const value = useMemo(
    () => ({
      state: stored.accountKey === accountKey ? stored.value : LOADING_STATE,
      retry,
    }),
    [accountKey, retry, stored]
  );

  return (
    <PricingAnalyticsContext.Provider value={value}>
      {children}
    </PricingAnalyticsContext.Provider>
  );
}

export function usePricingAnalytics(): PricingAnalyticsContextValue {
  const context = useContext(PricingAnalyticsContext);
  if (!context) {
    throw new Error(
      'usePricingAnalytics must be used inside PricingAnalyticsProvider'
    );
  }
  return context;
}
