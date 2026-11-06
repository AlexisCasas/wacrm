'use client';

import { MessageSquareText } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/dashboard/skeleton';
import { usePricingAnalytics } from '@/hooks/use-pricing-analytics';
import type { PricingAnalyticsResult } from '@/lib/whatsapp/pricing-analytics';

export const WHATSAPP_FREE_TIER_LIMIT = 1_000;

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

  return {
    used,
    limit: WHATSAPP_FREE_TIER_LIMIT,
    remaining: Math.max(WHATSAPP_FREE_TIER_LIMIT - used, 0),
  };
}

export function WhatsappFreeTierIndicator() {
  const t = useTranslations('Dashboard.whatsappUsage');
  const { state } = usePricingAnalytics();

  if (state.kind === 'loading') {
    return (
      <div
        className="border-border bg-card flex h-9 w-[5.5rem] items-center gap-2 rounded-lg border px-2 sm:w-28 lg:w-48"
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

  const { used, limit, remaining } = calculateWhatsappFreeTier(state.data);
  const usedLabel = formatCount(used);
  const limitLabel = formatCount(limit);
  const remainingLabel = formatCount(remaining);
  const fullLabel = t('freeTierAccessibleLabel', {
    used: usedLabel,
    limit: limitLabel,
    remaining: remainingLabel,
  });

  return (
    <div
      className="border-border bg-card text-foreground flex h-9 shrink-0 items-center gap-2 rounded-lg border px-2.5 sm:px-3"
      aria-label={fullLabel}
      title={fullLabel}
    >
      <MessageSquareText className="text-primary size-4 shrink-0" aria-hidden />
      <div className="min-w-0 leading-tight">
        <p className="text-xs font-semibold whitespace-nowrap sm:text-sm">
          <span className="hidden lg:inline">{t('freeTierLabel')}: </span>
          {usedLabel} / {limitLabel}
          <span className="hidden sm:inline"> {t('freeTierFree')}</span>
        </p>
        <p className="text-muted-foreground hidden text-[11px] whitespace-nowrap lg:block">
          {t('freeTierRemaining', { count: remainingLabel })}
        </p>
      </div>
    </div>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}
