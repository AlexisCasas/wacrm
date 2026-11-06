// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === 'freeTierLabel') return 'Free allowance';
    if (key === 'freeTierExhausted') return 'Allowance used up';
    if (key === 'freeTierRemaining') {
      const n = Number(values?.count);
      return `${n} available`;
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
  it('682 used: 318 remaining, 68.2% and the normal state', () => {
    expect(calculateWhatsappFreeTier(analytics(682))).toEqual({
      used: 682,
      limit: 1_000,
      remaining: 318,
      percentage: 68.2,
      status: 'normal',
    });
  });

  it('800 used is the first "close to the limit" value, 799 is still normal', () => {
    expect(calculateWhatsappFreeTier(analytics(799)).status).toBe('normal');
    expect(calculateWhatsappFreeTier(analytics(800)).status).toBe('warning');
    expect(calculateWhatsappFreeTier(analytics(999))).toMatchObject({
      remaining: 1,
      status: 'warning',
    });
  });

  it('1,000 and beyond: nothing remains, status exhausted, the bar never exceeds 100%', () => {
    expect(calculateWhatsappFreeTier(analytics(1_000))).toMatchObject({
      remaining: 0,
      percentage: 100,
      status: 'exhausted',
    });
    expect(calculateWhatsappFreeTier(analytics(1_500))).toMatchObject({
      used: 1_500,
      remaining: 0,
      percentage: 100,
      status: 'exhausted',
    });
  });

  it('FREE_ENTRY_POINT and REGULAR never change the free usage', () => {
    const base = calculateWhatsappFreeTier(analytics(682));
    expect(
      calculateWhatsappFreeTier(
        analytics(682, {
          breakdown: [
            { pricingType: 'FREE_CUSTOMER_SERVICE', category: 'SERVICE', volume: 682, cost: 0 },
            { pricingType: 'FREE_ENTRY_POINT', category: 'SERVICE', volume: 900_000, cost: 0 },
            { pricingType: 'REGULAR', category: 'SERVICE', volume: 5_000, cost: 150 },
            { pricingType: 'REGULAR', category: 'MARKETING', volume: 40, cost: 3 },
          ],
        })
      )
    ).toEqual(base);
  });

  it('only SERVICE free customer-service volume counts (other categories are ignored)', () => {
    expect(
      calculateWhatsappFreeTier(
        analytics(0, {
          breakdown: [
            { pricingType: 'FREE_CUSTOMER_SERVICE', category: 'SERVICE', volume: 10, cost: 0 },
            { pricingType: 'FREE_CUSTOMER_SERVICE', category: 'MARKETING', volume: 99, cost: 0 },
          ],
        })
      ).used
    ).toBe(10);
  });
});

function renderIndicator(accountKey = 'acct-1') {
  return render(
    <PricingAnalyticsProvider enabled accountKey={accountKey}>
      <WhatsappFreeTierIndicator />
    </PricingAnalyticsProvider>
  );
}

describe('WhatsappFreeTierIndicator', () => {
  it('682: "682 / 1,000", "318 available" and a 68.2% bar in the normal state', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    renderIndicator();

    expect(await screen.findByText('682 / 1,000')).toBeInTheDocument();
    expect(screen.getByText('318 available')).toBeInTheDocument();
    expect(screen.getByTestId('free-tier-progress')).toHaveStyle({ width: '68.2%' });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '68');
    expect(screen.getByLabelText(/682 \/ 1,000/)).toHaveAttribute('data-status', 'normal');
  });

  it('keeps the compact layout: the secondary line and the bar are hidden on small screens', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    renderIndicator();
    await screen.findByText('682 / 1,000');
    expect(screen.getByText('Free allowance')).toHaveClass('hidden', 'lg:inline');
    expect(screen.getByText('318 available').parentElement).toHaveClass('hidden', 'sm:flex');
    expect(screen.getByRole('progressbar')).toHaveClass('hidden', 'lg:block');
  });

  it('875 shows the discreet warning state without any modal or toast', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(875))));
    renderIndicator();
    expect(await screen.findByText('875 / 1,000')).toBeInTheDocument();
    expect(screen.getByText('125 available')).toHaveClass('text-amber-600');
    expect(screen.getByTestId('free-tier-progress')).toHaveClass('bg-amber-500');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('999 says 1 available', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(999))));
    renderIndicator();
    expect(await screen.findByText('999 / 1,000')).toBeInTheDocument();
    expect(screen.getByText('1 available')).toBeInTheDocument();
  });

  it('1,000: "1,000 / 1,000", "Allowance used up", full bar', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(1_000))));
    renderIndicator();
    expect(await screen.findByText('1,000 / 1,000')).toBeInTheDocument();
    expect(screen.getByText('Allowance used up')).toBeInTheDocument();
    expect(screen.getByTestId('free-tier-progress')).toHaveStyle({ width: '100%' });
    expect(screen.getByTestId('free-tier-progress')).toHaveClass('bg-destructive');
  });

  it('above 1,000 the header still reads 1,000 / 1,000, never a negative balance, and never the paid messages', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(1_247))));
    renderIndicator();
    expect(await screen.findByText('1,000 / 1,000')).toBeInTheDocument();
    expect(screen.queryByText(/-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/available/)).not.toBeInTheDocument();
    expect(screen.getByTestId('free-tier-progress')).toHaveStyle({ width: '100%' });
    expect(screen.queryByText(/73|2\.19|101/)).not.toBeInTheDocument(); // paid messages, cost, entry point live in the Panel
  });

  it('shows no costs, paid messages or analytics in the header', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    renderIndicator();
    await screen.findByText('682 / 1,000');
    expect(screen.queryByText(/2\.19|101,389|REGULAR|paid/i)).not.toBeInTheDocument();
  });

  it('shares one endpoint request with the main pricing widget', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(ready(analytics(682))));
    render(
      <PricingAnalyticsProvider enabled accountKey="acct-1">
        <WhatsappFreeTierIndicator />
        <WhatsappUsageWidget />
      </PricingAnalyticsProvider>
    );

    expect(await screen.findByText('682 / 1,000')).toBeInTheDocument();
    expect(await screen.findByText('paidMessages')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('invalidates the snapshot and reloads when the account changes', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(jsonResponse(ready(analytics(682))))
      .mockReturnValueOnce(jsonResponse(ready(analytics(25))));

    const { rerender } = renderIndicator('acct-1');
    expect(await screen.findByText('682 / 1,000')).toBeInTheDocument();

    rerender(
      <PricingAnalyticsProvider enabled accountKey="acct-2">
        <WhatsappFreeTierIndicator />
      </PricingAnalyticsProvider>
    );
    expect(await screen.findByText('25 / 1,000')).toBeInTheDocument();
    expect(screen.queryByText('682 / 1,000')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an upstream error', { reason: 'meta_error' }, 502],
    ['missing configuration', { status: 'unavailable', reason: 'no_config' }, 200],
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
