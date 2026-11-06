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
    render(<WhatsappUsageWidget />);
    expect(screen.getByLabelText('loading')).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('renders summaries and the dynamic Meta breakdown', async () => {
    vi.mocked(fetch).mockReturnValue(jsonResponse(READY));
    render(<WhatsappUsageWidget />);

    expect(await screen.findByText('paidMessages')).toBeInTheDocument();
    expect(screen.getByText('73')).toBeInTheDocument();
    expect(screen.getByText('2.19')).toBeInTheDocument();
    expect(screen.getByText('101,389')).toBeInTheDocument();
    expect(screen.getByText('noCurrency')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'viewDetail' }));
    expect(await screen.findByText('detailTitle')).toBeInTheDocument();
    expect(screen.getByText('REGULAR')).toBeInTheDocument();
    expect(screen.getByText('SERVICE')).toBeInTheDocument();
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
    render(<WhatsappUsageWidget />);
    await screen.findByText('paidMessages');
    fireEvent.click(screen.getByRole('button', { name: 'viewDetail' }));
    expect(await screen.findByText('noBreakdown')).toBeInTheDocument();
  });

  it('keeps a missing configuration local to this widget', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({ status: 'unavailable', reason: 'no_config' })
    );
    render(<WhatsappUsageWidget />);
    expect(await screen.findByText('noConfigTitle')).toBeInTheDocument();
    expect(screen.getByText('noConfigHint')).toBeInTheDocument();
  });

  it('shows a retryable error without throwing into the dashboard', async () => {
    vi.mocked(fetch).mockReturnValue(
      jsonResponse({ reason: 'meta_error' }, 502)
    );
    render(<WhatsappUsageWidget />);
    expect(await screen.findByRole('alert')).toHaveTextContent('errorTitle');

    vi.mocked(fetch).mockReturnValue(jsonResponse(READY));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() =>
      expect(screen.getByText('paidMessages')).toBeInTheDocument()
    );
  });
});
