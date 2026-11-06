import { NextResponse, type NextRequest } from 'next/server';

import {
  ForbiddenError,
  UnauthorizedError,
  getCurrentAccount,
} from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  MetaPricingAnalyticsError,
  PricingPeriodError,
  fetchPricingAnalytics,
  resolvePricingPeriod,
} from '@/lib/whatsapp/pricing-analytics';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' };

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

export async function GET(request: NextRequest) {
  try {
    const context = await getCurrentAccount();
    const period = resolvePricingPeriod({
      start: request.nextUrl.searchParams.get('start'),
      end: request.nextUrl.searchParams.get('end'),
    });

    // The account id always comes from the authenticated profile. No query
    // parameter can select another tenant's WhatsApp configuration.
    const { data: config, error } = await context.supabase
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('account_id', context.accountId)
      .maybeSingle();

    if (error) {
      console.error('[pricing analytics] configuration lookup failed');
      return json(
        { status: 'error', reason: 'configuration_error' },
        { status: 500 }
      );
    }
    if (!config) {
      return json({ status: 'unavailable', reason: 'no_config' });
    }
    if (!config.waba_id) {
      return json({ status: 'unavailable', reason: 'missing_waba' });
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch {
      return json({ status: 'unavailable', reason: 'token_invalid' });
    }

    const analytics = await fetchPricingAnalytics({
      wabaId: config.waba_id,
      accessToken,
      period,
    });
    return json({ status: 'ready', ...analytics });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return json({ status: 'error', reason: 'unauthorized' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return json({ status: 'error', reason: 'no_account' }, { status: 403 });
    }
    if (error instanceof PricingPeriodError) {
      return json(
        { status: 'error', reason: 'invalid_period' },
        { status: 400 }
      );
    }
    if (error instanceof MetaPricingAnalyticsError) {
      // Meta code 190 means the stored token is expired/invalid. Surface the
      // same controlled settings state as a local decrypt failure, without
      // exposing Meta's response body to the browser.
      if (error.code === 190) {
        return json({ status: 'unavailable', reason: 'token_invalid' });
      }
      console.error('[pricing analytics] Meta request failed', {
        httpStatus: error.httpStatus,
        code: error.code,
        errorSubcode: error.errorSubcode,
      });
      return json(
        { status: 'error', reason: 'meta_error' },
        {
          status: 502,
          headers:
            error.retryAfterSeconds === undefined
              ? undefined
              : { 'Retry-After': String(error.retryAfterSeconds) },
        }
      );
    }

    console.error('[pricing analytics] unexpected failure');
    return json({ status: 'error', reason: 'unknown' }, { status: 500 });
  }
}
