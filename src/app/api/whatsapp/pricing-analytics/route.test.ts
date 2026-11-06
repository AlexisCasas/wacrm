import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return { ...actual, getCurrentAccount: vi.fn() };
});

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn() }));

vi.mock('@/lib/whatsapp/pricing-analytics', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/pricing-analytics')>();
  return { ...actual, fetchPricingAnalytics: vi.fn() };
});

import {
  ForbiddenError,
  UnauthorizedError,
  getCurrentAccount,
} from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  MetaPricingAnalyticsError,
  fetchPricingAnalytics,
  resolvePricingPeriod,
} from '@/lib/whatsapp/pricing-analytics';
import { GET } from './route';

const mockedAccount = vi.mocked(getCurrentAccount);
const mockedDecrypt = vi.mocked(decrypt);
const mockedFetchPricing = vi.mocked(fetchPricingAnalytics);
const period = resolvePricingPeriod({ start: '2026-10-31', end: '2026-11-07' });

const READY = {
  period,
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

function request(query = '') {
  return new NextRequest(
    `http://localhost/api/whatsapp/pricing-analytics${query}`
  );
}

function accountContext(config: unknown, dbError: unknown = null) {
  const maybeSingle = vi.fn(async () => ({ data: config, error: dbError }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return {
    context: {
      accountId: 'acct-session',
      account: { id: 'acct-session', name: 'Session account' },
      role: 'owner',
      userId: 'user-1',
      supabase: { from },
    },
    eq,
  };
}

beforeEach(() => {
  mockedDecrypt.mockReturnValue('plain-access-token');
  mockedFetchPricing.mockResolvedValue(READY);
});

describe('GET /api/whatsapp/pricing-analytics', () => {
  it('rejects an unauthenticated user', async () => {
    mockedAccount.mockRejectedValue(new UnauthorizedError());
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      status: 'error',
      reason: 'unauthorized',
    });
  });

  it('returns a controlled response for a user without an account', async () => {
    mockedAccount.mockRejectedValue(
      new ForbiddenError('Profile is not linked')
    );
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      status: 'error',
      reason: 'no_account',
    });
  });

  it('handles an account without whatsapp_config', async () => {
    const { context } = accountContext(null);
    mockedAccount.mockResolvedValue(context as never);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'no_config',
    });
  });

  it('handles a configuration without a WABA', async () => {
    const { context } = accountContext({
      waba_id: null,
      access_token: 'ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'missing_waba',
    });
  });

  it('handles an undecryptable token without calling Meta', async () => {
    const { context } = accountContext({
      waba_id: 'waba-1',
      access_token: 'bad',
    });
    mockedAccount.mockResolvedValue(context as never);
    mockedDecrypt.mockImplementation(() => {
      throw new Error('decrypt failed');
    });
    const response = await GET(request());
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'token_invalid',
    });
    expect(mockedFetchPricing).not.toHaveBeenCalled();
  });

  it('returns normalized Meta data and never returns stored or decrypted secrets', async () => {
    const { context } = accountContext({
      waba_id: 'waba-1',
      access_token: 'stored-ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);

    const response = await GET(request('?start=2026-10-31&end=2026-11-07'));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', summary: READY.summary });
    expect(mockedFetchPricing).toHaveBeenCalledWith({
      wabaId: 'waba-1',
      accessToken: 'plain-access-token',
      period,
    });
    expect(serialized).not.toContain('stored-ciphertext');
    expect(serialized).not.toContain('plain-access-token');
  });

  it('uses only the session account id even if the URL contains another account id', async () => {
    const { context, eq } = accountContext({
      waba_id: 'waba-1',
      access_token: 'ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);
    await GET(request('?account_id=acct-other'));
    expect(eq).toHaveBeenCalledWith('account_id', 'acct-session');
  });

  it('returns an empty successful period without treating it as an error', async () => {
    const { context } = accountContext({
      waba_id: 'waba-1',
      access_token: 'ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);
    mockedFetchPricing.mockResolvedValue({
      ...READY,
      summary: {
        paidMessages: 0,
        estimatedCost: 0,
        freeCustomerService: 0,
        freeEntryPoint: 0,
      },
      breakdown: [],
    });
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      status: 'ready',
      breakdown: [],
      summary: { paidMessages: 0 },
    });
  });

  it('maps Meta errors to a controlled widget-only error', async () => {
    const { context } = accountContext({
      waba_id: 'waba-1',
      access_token: 'ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);
    mockedFetchPricing.mockRejectedValue(
      new MetaPricingAnalyticsError({
        httpStatus: 429,
        code: 4,
        retryAfterSeconds: 45,
      })
    );
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(await response.json()).toEqual({
      status: 'error',
      reason: 'meta_error',
    });
  });

  it('maps Meta token rejection to the controlled connection state', async () => {
    const { context } = accountContext({
      waba_id: 'waba-1',
      access_token: 'ciphertext',
    });
    mockedAccount.mockResolvedValue(context as never);
    mockedFetchPricing.mockRejectedValue(
      new MetaPricingAnalyticsError({ httpStatus: 401, code: 190 })
    );
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'token_invalid',
    });
  });
});
