import { describe, expect, it, vi } from 'vitest';

import {
  fetchPricingAnalytics,
  normalizePricingAnalytics,
  resolvePricingPeriod,
} from './pricing-analytics';

const PERIOD = resolvePricingPeriod({
  start: '2026-10-31',
  end: '2026-11-07',
});

describe('resolvePricingPeriod', () => {
  it('starts the current month at midnight in America/Lima', () => {
    const period = resolvePricingPeriod({
      now: new Date('2026-11-06T15:30:00.000Z'),
    });

    expect(period.start).toBe('2026-11-01T05:00:00.000Z');
    expect(period.end).toBe('2026-11-06T15:30:00.000Z');
    expect(period.timezone).toBe('America/Lima');
  });

  it('interprets explicit date bounds as Lima midnights and end-exclusive', () => {
    expect(PERIOD.start).toBe('2026-10-31T05:00:00.000Z');
    expect(PERIOD.end).toBe('2026-11-07T05:00:00.000Z');
    expect(PERIOD.startUnix).toBe(1793422800);
    expect(PERIOD.endUnix).toBe(1794027600);
  });

  it('rejects partial, invalid and overlong ranges', () => {
    expect(() => resolvePricingPeriod({ start: '2026-11-01' })).toThrow(
      /provided together/
    );
    expect(() =>
      resolvePricingPeriod({ start: '2026-11-31', end: '2026-12-01' })
    ).toThrow(/valid date/);
    expect(() =>
      resolvePricingPeriod({ start: '2025-01-01', end: '2026-12-31' })
    ).toThrow(/366 days/);
  });
});

describe('normalizePricingAnalytics', () => {
  it('aggregates paid categories, cost and free pricing types separately', () => {
    const result = normalizePricingAnalytics(
      {
        pricing_analytics: {
          data: [
            {
              data_points: [
                {
                  pricing_type: 'REGULAR',
                  pricing_category: 'SERVICE',
                  volume: 73,
                  cost: 2.19,
                },
                {
                  pricing_type: 'REGULAR',
                  pricing_category: 'MARKETING',
                  volume: 2,
                  cost: 0.1406,
                },
                {
                  pricing_type: 'FREE_CUSTOMER_SERVICE',
                  pricing_category: 'SERVICE',
                  volume: 682,
                  cost: 0,
                },
              ],
            },
            {
              data_points: [
                {
                  pricing_type: 'FREE_ENTRY_POINT',
                  pricing_category: 'SERVICE',
                  volume: 101389,
                  cost: 0,
                },
                {
                  pricing_type: 'REGULAR',
                  pricing_category: 'SERVICE',
                  volume: 1,
                  cost: 0.03,
                },
              ],
            },
          ],
        },
      },
      PERIOD
    );

    expect(result.summary).toEqual({
      paidMessages: 76,
      estimatedCost: 2.3606,
      freeCustomerService: 682,
      freeEntryPoint: 101389,
    });
    expect(result.breakdown).toEqual(
      expect.arrayContaining([
        {
          pricingType: 'REGULAR',
          category: 'SERVICE',
          volume: 74,
          cost: 2.22,
        },
        {
          pricingType: 'REGULAR',
          category: 'MARKETING',
          volume: 2,
          cost: 0.1406,
        },
      ])
    );
  });

  it('returns zero summaries and an empty breakdown when Meta has no data', () => {
    const result = normalizePricingAnalytics(
      { pricing_analytics: { data: [] } },
      PERIOD
    );
    expect(result.summary).toEqual({
      paidMessages: 0,
      estimatedCost: 0,
      freeCustomerService: 0,
      freeEntryPoint: 0,
    });
    expect(result.breakdown).toEqual([]);
  });

  it('does not invent a cost or currency when Meta omits them', () => {
    const result = normalizePricingAnalytics(
      {
        pricing_analytics: {
          data: [
            {
              data_points: [
                {
                  pricing_type: 'REGULAR',
                  pricing_category: 'UTILITY',
                  volume: 5,
                },
              ],
            },
          ],
        },
      },
      PERIOD
    );
    expect(result.summary.estimatedCost).toBeNull();
    expect(result.currency).toBeNull();
    expect(result.breakdown[0].cost).toBeNull();
  });
});

describe('fetchPricingAnalytics', () => {
  it('uses Graph v26, the audited dimensions and no-store without putting the token in the URL', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(
          JSON.stringify({ pricing_analytics: { data: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
    );

    await fetchPricingAnalytics({
      wabaId: '123456789',
      accessToken: 'private-token',
      period: PERIOD,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('graph.facebook.com/v26.0/123456789');
    expect(String(url)).toContain('pricing_analytics.start%281793422800%29');
    expect(String(url)).toContain('metric_types%28VOLUME%2CCOST%29');
    expect(String(url)).toContain(
      'dimensions%28PRICING_CATEGORY%2CPRICING_TYPE%29'
    );
    expect(String(url)).not.toContain('private-token');
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('turns Meta failures into a controlled error without returning the response body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'sensitive upstream detail',
              code: 190,
              error_subcode: 463,
            },
          }),
          { status: 401, headers: { 'retry-after': '30' } }
        )
    );

    const failure = fetchPricingAnalytics({
      wabaId: '123',
      accessToken: 'private-token',
      period: PERIOD,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(failure).rejects.toMatchObject({
      httpStatus: 401,
      code: 190,
      errorSubcode: 463,
      retryAfterSeconds: 30,
      message: 'Meta pricing analytics request failed',
    });
  });
});
