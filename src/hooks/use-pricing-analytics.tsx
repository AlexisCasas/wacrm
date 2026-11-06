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

const PricingAnalyticsContext =
  createContext<PricingAnalyticsContextValue | null>(null);

export function PricingAnalyticsProvider({
  enabled,
  accountKey,
  children,
}: {
  enabled: boolean;
  accountKey: string;
  children: ReactNode;
}) {
  const [stored, setStored] = useState<StoredState>({
    accountKey: null,
    value: LOADING_STATE,
  });
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();

    void fetch('/api/whatsapp/pricing-analytics', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('pricing analytics unavailable');
        return (await response.json()) as ApiResponse;
      })
      .then((body) => {
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
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        setStored({ accountKey, value: { kind: 'error' } });
      });

    return () => controller.abort();
  }, [accountKey, enabled, requestKey]);

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
