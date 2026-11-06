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

// Locales tried, in order, to find the currency's own symbol while keeping the same en-style numbers ("1,234.50"): en-US knows $, €, £, MX$ ...;
// es-PE adds S/ (PEN). A currency none of them has a symbol for is shown as the plain amount followed by its code.
const SYMBOL_LOCALES = ['en-US', 'es-PE'] as const;

function amountWithSymbol(value: number, currency: string): string | null {
  for (const locale of SYMBOL_LOCALES) {
    const format = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const symbol = format.formatToParts(value).find((part) => part.type === 'currency')?.value;
    // Intl falls back to the ISO code itself when it has no symbol: that is not a symbol, try the next locale.
    if (symbol && symbol.toUpperCase() !== currency) return format.format(value);
  }
  return null;
}

/**
 * "$40.48 USD", "S/ 40.48 PEN", "€40.48 EUR": 2 decimals, thousands separator, the symbol that belongs to the currency (never a fixed "$"), and
 * the ISO code always visible at the end. A currency without a known symbol (or an invalid code) renders as "40.48 XYZ".
 */
export function formatPricingAmount(
  value: number,
  reportedCurrency: string | null | undefined
): string {
  const currency = resolvePricingCurrency(reportedCurrency);
  let formatted: string | null = null;
  try {
    formatted = amountWithSymbol(value, currency);
  } catch {
    formatted = null; // RangeError: not a valid ISO 4217 code
  }
  const plain =
    formatted ??
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  // Intl separates letter symbols with a no-break space; use a normal space so the text is uniform and searchable.
  return `${plain} ${currency}`.replace(/\u00a0/g, ' ');
}
