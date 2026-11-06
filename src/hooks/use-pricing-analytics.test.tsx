// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRICING_ANALYTICS_REFRESH_MS,
  PricingAnalyticsProvider,
  usePricingAnalytics,
} from './use-pricing-analytics';

// The provider owns ONE request per cycle for every consumer (header indicator + Panel widget): fetch on entering the Panel, again every
// 5 minutes while it stays enabled, never concurrently, never outside the Panel, never leaking one account's numbers into another.
const MIN = 60 * 1000;

function body(freeCustomerService: number, paid = 73) {
  return {
    status: 'ready',
    period: { start: '', end: '', startUnix: 0, endUnix: 0, timezone: 'America/Lima' },
    summary: { paidMessages: paid, estimatedCost: 0, freeCustomerService, freeEntryPoint: 0 },
    breakdown: [],
    currency: null,
  };
}
const okResponse = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;

/** A fetch that honours AbortSignal like the real one. */
function pending() {
  let resolve!: (r: Response) => void;
  const promise = (signal?: AbortSignal) =>
    new Promise<Response>((res, rej) => {
      resolve = res;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
  return { promise, resolve: (r: Response) => resolve(r) };
}

function HeaderConsumer() {
  const { state } = usePricingAnalytics();
  return <p data-testid="header">{state.kind === 'ready' ? `free:${state.data.summary.freeCustomerService}` : state.kind}</p>;
}
function PanelConsumer() {
  const { state } = usePricingAnalytics();
  return <p data-testid="panel">{state.kind === 'ready' ? `paid:${state.data.summary.paidMessages}` : state.kind}</p>;
}
function Both({ enabled = true, accountKey = 'acct-1', refreshIntervalMs }: { enabled?: boolean; accountKey?: string; refreshIntervalMs?: number }) {
  return (
    <PricingAnalyticsProvider enabled={enabled} accountKey={accountKey} refreshIntervalMs={refreshIntervalMs}>
      <HeaderConsumer />
      <PanelConsumer />
    </PricingAnalyticsProvider>
  );
}

const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.length;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PricingAnalyticsProvider — automatic refresh', () => {
  it('the interval is 5 minutes', () => {
    expect(PRICING_ANALYTICS_REFRESH_MS).toBe(5 * MIN);
  });

  it('1/2. fetches immediately on entering the Panel, then again every 5 minutes (not before)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both />);
    await flush();
    expect(calls()).toBe(1);
    expect(screen.getByTestId('header')).toHaveTextContent('free:682');

    await advance(5 * MIN - 1000);
    expect(calls()).toBe(1);
    await advance(1000);
    expect(calls()).toBe(2);
    await advance(5 * MIN);
    expect(calls()).toBe(3);
  });

  it('shows what Meta changed after a refresh (73 -> 110 paid, 682 -> 700 free) without a reload', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(682, 73))))
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(700, 110))));
    render(<Both />);
    await flush();
    expect(screen.getByTestId('panel')).toHaveTextContent('paid:73');
    await advance(5 * MIN);
    expect(screen.getByTestId('panel')).toHaveTextContent('paid:110');
    expect(screen.getByTestId('header')).toHaveTextContent('free:700');
  });

  it('3/4. header and Panel are two consumers of ONE request per cycle', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both />);
    await flush();
    expect(calls()).toBe(1);
    expect(screen.getByTestId('header')).toHaveTextContent('free:682');
    expect(screen.getByTestId('panel')).toHaveTextContent('paid:73');
    await advance(5 * MIN);
    expect(calls()).toBe(2); // not 4
    await advance(5 * MIN);
    expect(calls()).toBe(3);
  });

  it('5. outside the Panel (disabled) nothing is fetched and no timer exists', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both enabled={false} />);
    await advance(30 * MIN);
    expect(calls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaving the Panel stops the polling; coming back fetches immediately again', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    const { rerender } = render(<Both enabled />);
    await flush();
    expect(calls()).toBe(1);

    rerender(<Both enabled={false} />);
    await advance(20 * MIN);
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    rerender(<Both enabled />);
    await flush();
    expect(calls()).toBe(2);
    await advance(5 * MIN);
    expect(calls()).toBe(3);
  });

  it('6. unmounting clears the interval and nothing is fetched afterwards', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    const { unmount } = render(<Both />);
    await flush();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30 * MIN);
    expect(calls()).toBe(1);
  });

  it('7/8. an account switch hides the previous numbers at once and fetches again; a late answer for the old account is ignored', async () => {
    const first = pending();
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => first.promise(init.signal ?? undefined))
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(25))));
    const { rerender } = render(<Both accountKey="acct-1" />);
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('loading');

    rerender(<Both accountKey="acct-2" />);
    expect(screen.getByTestId('header')).toHaveTextContent('loading'); // never shows acct-1
    await flush();
    expect(calls()).toBe(2);
    expect(screen.getByTestId('header')).toHaveTextContent('free:25');

    first.resolve(okResponse(body(999))); // acct-1's late answer
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('free:25');
  });

  it('switching accounts after data was shown never exposes the old numbers while the new ones load', async () => {
    const second = pending();
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(682))))
      .mockImplementationOnce((_url: string, init: RequestInit) => second.promise(init.signal ?? undefined));
    const { rerender } = render(<Both accountKey="acct-1" />);
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('free:682');

    rerender(<Both accountKey="acct-2" />);
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('loading');
    expect(screen.queryByText('free:682')).not.toBeInTheDocument();
    second.resolve(okResponse(body(25)));
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('free:25');
  });

  it('9/10. a failed refresh keeps the last valid numbers, does not loop, and the next cycle retries', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(682))))
      .mockImplementationOnce(() => Promise.reject(new Error('meta down')))
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(701))));
    render(<Both />);
    await flush();
    await advance(5 * MIN);
    expect(calls()).toBe(2);
    expect(screen.getByTestId('header')).toHaveTextContent('free:682'); // not blanked by a transient error

    await advance(4 * MIN); // no rapid retry between cycles
    expect(calls()).toBe(2);
    await advance(1 * MIN);
    expect(calls()).toBe(3);
    expect(screen.getByTestId('header')).toHaveTextContent('free:701');
  });

  it('a first-load error shows the error state, does not retry before the next cycle, then recovers', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 502, json: async () => ({}) } as Response))
      .mockImplementationOnce(() => Promise.resolve(okResponse(body(682))));
    render(<Both />);
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('error');
    await advance(4 * MIN + 59 * 1000);
    expect(calls()).toBe(1);
    await advance(1000);
    expect(calls()).toBe(2);
    expect(screen.getByTestId('header')).toHaveTextContent('free:682');
  });

  it('11. never runs two requests at once: a tick that arrives while one is in flight is skipped', async () => {
    const slow = pending();
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => slow.promise(init.signal ?? undefined))
      .mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both refreshIntervalMs={30 * 1000} />);
    await flush();
    expect(calls()).toBe(1);
    await advance(30 * 1000); // tick while the first is still pending
    expect(calls()).toBe(1);
    slow.resolve(okResponse(body(500)));
    await flush();
    expect(screen.getByTestId('header')).toHaveTextContent('free:500');
    await advance(30 * 1000);
    expect(calls()).toBe(2);
  });

  it('a request that never answers is aborted after a minute so it cannot block the next cycles', async () => {
    const hung = pending();
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => hung.promise(init.signal ?? undefined))
      .mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both />);
    await flush();
    await advance(61 * 1000);
    expect(screen.getByTestId('header')).toHaveTextContent('error');
    await advance(5 * MIN);
    expect(calls()).toBe(2);
    expect(screen.getByTestId('header')).toHaveTextContent('free:682');
  });

  it('never sends an account id: the request is a plain GET of the endpoint (the server resolves the account from the session)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(body(682))));
    render(<Both accountKey="acct-with-secret-looking-id" />);
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/whatsapp/pricing-analytics');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain('acct-with-secret-looking-id');
  });
});
