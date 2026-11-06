'use client';

import {
  BadgeDollarSign,
  Gift,
  MessageSquareText,
  MousePointerClick,
  RefreshCw,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/dashboard/skeleton';
import { usePricingAnalytics } from '@/hooks/use-pricing-analytics';
import type { PricingAnalyticsResult } from '@/lib/whatsapp/pricing-analytics';
import { formatPricingAmount } from '@/lib/whatsapp/pricing-currency';

type UnavailableReason = 'no_config' | 'missing_waba' | 'token_invalid';

export function WhatsappUsageWidget() {
  const t = useTranslations('Dashboard.whatsappUsage');
  const { state, retry } = usePricingAnalytics();

  if (state.kind === 'loading') return <UsageSkeleton label={t('loading')} />;
  if (state.kind === 'error') {
    return (
      <StatusCard title={t('errorTitle')} description={t('errorHint')} alert>
        <Button variant="outline" size="sm" onClick={retry}>
          <RefreshCw aria-hidden />
          {t('retry')}
        </Button>
      </StatusCard>
    );
  }
  if (state.kind === 'unavailable') {
    const copy = unavailableCopy(state.reason, t);
    return <StatusCard title={copy.title} description={copy.description} />;
  }

  const { data } = state;
  return (
    <section
      className="border-border bg-card rounded-xl border p-5"
      aria-labelledby="whatsapp-usage-title"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareText className="text-primary h-5 w-5" aria-hidden />
            <h2
              id="whatsapp-usage-title"
              className="text-foreground font-semibold"
            >
              {t('title')}
            </h2>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('periodCurrentMonth')}
          </p>
        </div>

        <PricingDetailDialog data={data} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <UsageMetric
          label={t('paidMessages')}
          value={formatCount(data.summary.paidMessages)}
          icon={BadgeDollarSign}
        />
        <UsageMetric
          label={t('estimatedCost')}
          value={formatCost(
            data.summary.estimatedCost,
            data.currency,
            t('costUnavailable')
          )}
          icon={BadgeDollarSign}
        />
        <UsageMetric
          label={t('freeCustomerService')}
          value={formatCount(data.summary.freeCustomerService)}
          icon={Gift}
        />
        <UsageMetric
          label={t('freeEntryPoint')}
          value={formatCount(data.summary.freeEntryPoint)}
          icon={MousePointerClick}
        />
      </div>
    </section>
  );
}

function PricingDetailDialog({ data }: { data: PricingAnalyticsResult }) {
  const t = useTranslations('Dashboard.whatsappUsage');
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t('viewDetail')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('detailTitle')}</DialogTitle>
          <DialogDescription>{t('detailDescription')}</DialogDescription>
        </DialogHeader>

        {data.breakdown.length === 0 ? (
          <div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            {t('noBreakdown')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('type')}</TableHead>
                <TableHead>{t('category')}</TableHead>
                <TableHead className="text-right">{t('volume')}</TableHead>
                <TableHead className="text-right">{t('cost')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.breakdown.map((item) => (
                <TableRow key={`${item.pricingType}:${item.category}`}>
                  <TableCell className="font-medium">
                    {item.pricingType}
                  </TableCell>
                  <TableCell>{item.category}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(item.volume)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(item.cost, data.currency, '—')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

      </DialogContent>
    </Dialog>
  );
}

function UsageMetric({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof BadgeDollarSign;
}) {
  return (
    <div className="border-border bg-background/50 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-sm font-medium">{label}</p>
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
      </div>
      <p className="text-foreground mt-3 text-2xl font-bold tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

function UsageSkeleton({ label }: { label: string }) {
  return (
    <section
      className="border-border bg-card rounded-xl border p-5"
      aria-label={label}
      aria-busy="true"
    >
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
    </section>
  );
}

function StatusCard({
  title,
  description,
  alert = false,
  children,
}: {
  title: string;
  description: string;
  alert?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="border-border bg-card rounded-xl border p-5"
      role={alert ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3">
        <MessageSquareText
          className="text-muted-foreground mt-0.5 h-5 w-5"
          aria-hidden
        />
        <div>
          <h2 className="text-foreground font-semibold">{title}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </section>
  );
}

function unavailableCopy(
  reason: UnavailableReason,
  t: ReturnType<typeof useTranslations<'Dashboard.whatsappUsage'>>
) {
  if (reason === 'missing_waba') {
    return { title: t('missingWabaTitle'), description: t('missingWabaHint') };
  }
  if (reason === 'token_invalid') {
    return {
      title: t('tokenInvalidTitle'),
      description: t('tokenInvalidHint'),
    };
  }
  return { title: t('noConfigTitle'), description: t('noConfigHint') };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

// Amounts are shown as "$40.48 USD" (2 decimals); the currency decision lives in pricing-currency.ts. The value received from Meta is untouched.
function formatCost(
  value: number | null,
  currency: string | null,
  unavailable: string
): string {
  if (value === null) return unavailable;
  return formatPricingAmount(value, currency);
}
