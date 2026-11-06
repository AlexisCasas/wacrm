/**
 * Currency shown next to WhatsApp pricing amounts — the ONLY place where it is decided.
 *
 * Meta's `pricing_analytics` response has not included a currency for the connected accounts, while WhatsApp Manager shows their charges in USD
 * (e.g. "Cargos totales aproximados $40.48 USD"). So: a currency reported by Meta (see normalizePricingAnalytics) always wins; when Meta
 * reports none, DEFAULT_PRICING_CURRENCY is used. If a connected WABA is ever billed in another currency and Meta still does not report it,
 * change this constant (or read the WABA's own `currency` field server-side) — no component repeats the value.
 *
 * Display only: the numbers received from Meta are never altered, only rounded to 2 decimals when rendered.
 */
export const DEFAULT_PRICING_CURRENCY = 'USD';

export function resolvePricingCurrency(reported: string | null | undefined): string {
  const code = reported?.trim().toUpperCase();
  return code ? code : DEFAULT_PRICING_CURRENCY;
}

/** "$40.48 USD" (2 decimals, en-US grouping like WhatsApp Manager). A currency Intl does not know falls back to "40.48 XYZ". */
export function formatPricingAmount(
  value: number,
  reportedCurrency: string | null | undefined
): string {
  const currency = resolvePricingCurrency(reportedCurrency);
  try {
    const amount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
    return `${amount} ${currency}`;
  } catch {
    const amount = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
    return `${amount} ${currency}`;
  }
}
