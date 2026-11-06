// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === 'freeTierLabel') return 'Free allowance';
    if (key === 'freeTierFree') return 'free';
    if (key === 'freeTierRemaining') return `${values?.count} available`;
    if (key === 'freeTierAccessibleLabel') {
      return `${values?.used} / ${values?.limit}; ${values?.remaining} available`;
    }
    return key;
  },
}));

import { PricingAnalyticsProvider } from '@/hooks/use-pricing-analytics';
import type { PricingAnalyticsResult } from '@/lib/whatsapp/pricing-analytics';
import {
  calculateWhatsappFreeTier,
  WhatsappFreeTierIndicator,
} from './whatsapp-free-tier-indicator';
import { WhatsappUsageWidget } from './whatsapp-usage-widget';

const PERIOD = {
  start: '2026-11-01T05:00:00.000Z',
  end: '2026-11-06T15:30:00.000Z',
  startUnix: 1793509200,
  endUnix: 1793979000,
  timezone: 'America/Lima' as const,
};

function analytics(
  freeCustomerService: number,
  overrides: Partial<PricingAnalyticsResult> = {}
): PricingAnalyticsResult {
  return {
    period: PERIOD,
    summary: {
      paidMessages: 73,
      estimatedCost: 2.19,
      freeCustomerService,
      freeEntryPoint: 101_389,
    },
    breakdown: [
      {
        pricingType: 'FREE_CUSTOMER_SERVICE',
        category: 'SERVICE',
        volume: freeCustomerService,
        cost: 0,
      },
      {
        pricingType: 'FREE_ENTRY_POINT',
        category: 'SERVICE',
        volume: 101_389,
        cost: 0,
      },
      {
        pricingType: 'REGULAR',
        category: 'SERVICE',
        volume: 73,
        cost: 2.19,
      },
    ],
    currency: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function ready(data: PricingAnalyticsResult) {
  return { status: 'ready', ...data };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('calculateWhatsappFreeTier', () => {
  it('calculates 682 / 1,000 with 318 remaining', () => {
    expect(calculateWhatsappFreeTier(analytics(682))).toMatchObject({
      used: 682,
      limit: 1_000,
      remaining: 318,
    });
  });

  it('returns zero remaining at and above the limit', () => {
    expect(calculateWhatsappFreeTier(analytics(1_000)).remaining).toBe(0);
    expect(calculateWhatsappFreeTier(analytics(1_250)).remaining).toBe(0);
  });

  it('excludes FREE_ENTRY_POINT and REGULAR from free usage', () => {
    expect(calculateWhatsappFreeTier(analytics(682))).toEqual({
      used: 682,
      limit: 1_000,
      remaining: 318,
    });
  });
});

describe('WhatsappFreeTierIndicator', () => {
  it('renders the compact allowance and desktop-only remaining balance', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    render(
      <PricingAnalyticsProvider enabled accountKey="acct-1">
        <WhatsappFreeTierIndicator />
      </PricingAnalyticsProvider>
    );

    expect(await screen.findByText(/682 \/ 1,000/)).toBeInTheDocument();
    expect(screen.getByText(/318 available/)).toHaveClass('hidden', 'lg:block');
    expect(screen.getByText('Free allowance:')).toHaveClass(
      'hidden',
      'lg:inline'
    );
  });

  it('shares one endpoint request with the main pricing widget', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    render(
      <PricingAnalyticsProvider enabled accountKey="acct-1">
        <WhatsappFreeTierIndicator />
        <WhatsappUsageWidget />
      </PricingAnalyticsProvider>
    );

    expect(await screen.findByText(/682 \/ 1,000/)).toBeInTheDocument();
    expect(await screen.findByText('paidMessages')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('invalidates the snapshot and reloads when the account changes', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(jsonResponse(ready(analytics(682))))
      .mockReturnValueOnce(jsonResponse(ready(analytics(25))));

    const { rerender } = render(
      <PricingAnalyticsProvider enabled accountKey="acct-1">
        <WhatsappFreeTierIndicator />
      </PricingAnalyticsProvider>
    );
    expect(await screen.findByText(/682 \/ 1,000/)).toBeInTheDocument();

    rerender(
      <PricingAnalyticsProvider enabled accountKey="acct-2">
        <WhatsappFreeTierIndicator />
      </PricingAnalyticsProvider>
    );
    expect(await screen.findByText(/25 \/ 1,000/)).toBeInTheDocument();
    expect(screen.queryByText(/682 \/ 1,000/)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an upstream error', { reason: 'meta_error' }, 502],
    [
      'missing configuration',
      { status: 'unavailable', reason: 'no_config' },
      200,
    ],
  ])('keeps the header intact for %s', async (_label, body, status) => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(body, status));
    render(
      <PricingAnalyticsProvider enabled accountKey="acct-1">
        <span>Header controls</span>
        <WhatsappFreeTierIndicator />
      </PricingAnalyticsProvider>
    );

    await waitFor(() =>
      expect(screen.queryByLabelText('freeTierLoading')).not.toBeInTheDocument()
    );
    expect(screen.getByText('Header controls')).toBeInTheDocument();
    expect(screen.queryByText(/\/ 1,000/)).not.toBeInTheDocument();
  });
});
