'use client';

import { MessageSquareText } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/dashboard/skeleton';
import { usePricingAnalytics } from '@/hooks/use-pricing-analytics';
import { cn } from '@/lib/utils';
import type { PricingAnalyticsResult } from '@/lib/whatsapp/pricing-analytics';

export const WHATSAPP_FREE_TIER_LIMIT = 1_000;
/** From this many used messages the indicator shows a discreet "close to the limit" signal. */
export const WHATSAPP_FREE_TIER_WARNING_AT = 800;

export type FreeTierStatus = 'normal' | 'warning' | 'exhausted';

export function calculateWhatsappFreeTier(data: PricingAnalyticsResult) {
  let used = 0;

  for (const item of data.breakdown) {
    if (
      item.pricingType === 'FREE_CUSTOMER_SERVICE' &&
      item.category === 'SERVICE'
    ) {
      used += item.volume;
    }
  }

  const status: FreeTierStatus =
    used >= WHATSAPP_FREE_TIER_LIMIT
      ? 'exhausted'
      : used >= WHATSAPP_FREE_TIER_WARNING_AT
        ? 'warning'
        : 'normal';

  return {
    used,
    limit: WHATSAPP_FREE_TIER_LIMIT,
    remaining: Math.max(WHATSAPP_FREE_TIER_LIMIT - used, 0),
    // Presentation only: the bar never goes past full.
    percentage: Math.min((used / WHATSAPP_FREE_TIER_LIMIT) * 100, 100),
    status,
  };
}

export function WhatsappFreeTierIndicator() {
  const t = useTranslations('Dashboard.whatsappUsage');
  const { state } = usePricingAnalytics();

  if (state.kind === 'loading') {
    return (
      <div
        className="border-border bg-card flex h-9 w-[5.5rem] items-center gap-2 rounded-lg border px-2 sm:w-28 lg:w-52"
        aria-label={t('freeTierLoading')}
        aria-busy="true"
      >
        <Skeleton className="size-4 shrink-0 rounded-full" />
        <Skeleton className="h-3 flex-1" />
      </div>
    );
  }

  // Configuration and upstream failures stay local: the rest of the header
  // remains unchanged and the full widget provides the actionable message.
  if (state.kind !== 'ready') return null;

  const { used, limit, remaining, percentage, status } =
    calculateWhatsappFreeTier(state.data);
  const limitLabel = formatCount(limit);
  const remainingText =
    status === 'exhausted'
      ? t('freeTierExhausted')
      : t('freeTierRemaining', { count: remaining });
  // Beyond the limit the visible number stays at the limit ("1,000 / 1,000"): the paid messages are shown in the Panel only.
  const shownLabel = formatCount(Math.min(used, limit));
  const fullLabel = `${t('freeTierLabel')}: ${shownLabel} / ${limitLabel}. ${remainingText}`;

  return (
    <div
      data-status={status}
      className="border-border bg-card text-foreground flex h-9 shrink-0 items-center gap-2 rounded-lg border px-2.5 sm:px-3"
      aria-label={fullLabel}
      title={fullLabel}
    >
      <MessageSquareText
        className={cn(
          'size-4 shrink-0',
          status === 'exhausted' ? 'text-destructive' : 'text-primary'
        )}
        aria-hidden
      />
      <div className="min-w-0 leading-none">
        <p className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-muted-foreground hidden text-[10px] font-medium tracking-wide uppercase lg:inline">
            {t('freeTierLabel')}
          </span>
          <span className="text-xs font-semibold tabular-nums sm:text-sm">
            {shownLabel} / {limitLabel}
          </span>
        </p>
        <div className="mt-1 hidden items-center gap-2 sm:flex">
          <span
            className={cn(
              'text-[11px] whitespace-nowrap tabular-nums',
              status === 'warning' && 'text-amber-600 dark:text-amber-400',
              status === 'exhausted' && 'text-destructive',
              status === 'normal' && 'text-muted-foreground'
            )}
          >
            {remainingText}
          </span>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percentage)}
            aria-label={t('freeTierLabel')}
            className="bg-muted hidden h-1 w-14 overflow-hidden rounded-full lg:block"
          >
            <div
              data-testid="free-tier-progress"
              className={cn(
                'h-full rounded-full',
                status === 'normal' && 'bg-primary',
                status === 'warning' && 'bg-amber-500',
                status === 'exhausted' && 'bg-destructive'
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}
