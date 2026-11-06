// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { WhatsappUsageWidget } from './whatsapp-usage-widget';
import { PricingAnalyticsProvider } from '@/hooks/use-pricing-analytics';

const READY = {
  status: 'ready',
  period: {
    start: '2026-11-01T05:00:00.000Z',
    end: '2026-11-06T15:30:00.000Z',
    startUnix: 1793509200,
    endUnix: 1793979000,
    timezone: 'America/Lima',
  },
  summary: {
    paidMessages: 73,
    estimatedCost: 2.19,
    freeCustomerService: 682,
    freeEntryPoint: 101389,
  },
  breakdown: [
    {
      pricingType: 'REGULAR',
      category: 'SERVICE',
      volume: 73,
      cost: 2.19,
    },
  ],
  currency: null,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function renderWidget(accountKey = 'acct-1') {
  return render(
    <PricingAnalyticsProvider enabled accountKey={accountKey}>
      <WhatsappUsageWidget />
    </PricingAnalyticsProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WhatsappUsageWidget', () => {
  it('shows a dashboard-native loading state', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    renderWidget();
    expect(screen.getByLabelText('loading')).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('renders summaries and the dynamic Meta breakdown', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(READY));
    renderWidget();

    expect(await screen.findByText('paidMessages')).toBeInTheDocument();
    expect(screen.getByText('73')).toBeInTheDocument();
    expect(screen.getByText('2.19')).toBeInTheDocument();
    expect(screen.getByText('101,389')).toBeInTheDocument();
    // no currency is invented and the old "Meta did not report the currency" hint is gone from the card
    expect(screen.queryByText('noCurrency')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'viewDetail' }));
    expect(await screen.findByText('detailTitle')).toBeInTheDocument();
    expect(screen.getByText('REGULAR')).toBeInTheDocument();
    expect(screen.getByText('SERVICE')).toBeInTheDocument();
  });

  it.each([
    [40.4803, '40.48'],
    [2.19, '2.19'],
    [0, '0.00'],
    [40.4851, '40.49'],
    [1234.5, '1,234.50'],
  ])('the cost card shows %s as %s (2 decimals, no currency)', async (cost, shown) => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({ ...READY, summary: { ...READY.summary, estimatedCost: cost }, breakdown: [] })
    );
    renderWidget();
    await screen.findByText('paidMessages');
    const card = screen.getByText('estimatedCost').closest('div')!.parentElement as HTMLElement;
    expect(card).toHaveTextContent(shown);
    expect(card.textContent).not.toMatch(/USD|PEN|S\/|\$/);
    expect(card.textContent).not.toMatch(/noCurrency/);
  });

  it('the detail table keeps the full precision Meta returned', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({
        ...READY,
        summary: { ...READY.summary, estimatedCost: 40.4803 },
        breakdown: [{ pricingType: 'REGULAR', category: 'SERVICE', volume: 5, cost: 40.4803 }],
      })
    );
    renderWidget();
    await screen.findByText('paidMessages');
    fireEvent.click(screen.getByRole('button', { name: 'viewDetail' }));
    expect(await screen.findByText('40.4803')).toBeInTheDocument();
  });

  it('renders a valid zero/empty state', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({
        ...READY,
        summary: {
          paidMessages: 0,
          estimatedCost: 0,
          freeCustomerService: 0,
          freeEntryPoint: 0,
        },
        breakdown: [],
      })
    );
    renderWidget();
    await screen.findByText('paidMessages');
    fireEvent.click(screen.getByRole('button', { name: 'viewDetail' }));
    expect(await screen.findByText('noBreakdown')).toBeInTheDocument();
  });

  it('keeps a missing configuration local to this widget', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({ status: 'unavailable', reason: 'no_config' })
    );
    renderWidget();
    expect(await screen.findByText('noConfigTitle')).toBeInTheDocument();
    expect(screen.getByText('noConfigHint')).toBeInTheDocument();
  });

  it('shows a retryable error without throwing into the dashboard', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({ reason: 'meta_error' }, 502)
    );
    renderWidget();
    expect(await screen.findByRole('alert')).toHaveTextContent('errorTitle');

    vi.mocked(fetch).mockReturnValue(jsonResponse(READY));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() =>
      expect(screen.getByText('paidMessages')).toBeInTheDocument()
    );
  });
});
