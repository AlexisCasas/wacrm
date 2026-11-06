import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRICING_CURRENCY,
  formatPricingAmount,
  resolvePricingCurrency,
} from './pricing-currency';

describe('pricing currency (single source of presentation)', () => {
  it('the default is USD, matching WhatsApp Manager for the connected accounts', () => {
    expect(DEFAULT_PRICING_CURRENCY).toBe('USD');
    expect(resolvePricingCurrency(null)).toBe('USD');
    expect(resolvePricingCurrency(undefined)).toBe('USD');
    expect(resolvePricingCurrency('  ')).toBe('USD');
  });

  it('a currency reported by Meta wins and is normalised', () => {
    expect(resolvePricingCurrency('pen')).toBe('PEN');
  });

  it.each([
    [40.4803, '$40.48 USD'],
    [2.19, '$2.19 USD'],
    [0, '$0.00 USD'],
    [1234.5, '$1,234.50 USD'],
    [0.0703, '$0.07 USD'],
    [40.41, '$40.41 USD'],
    [40.4851, '$40.49 USD'],
  ])('%s is shown as %s', (value, shown) => {
    expect(formatPricingAmount(value, null)).toBe(shown);
  });

  it('shows a reported currency code instead of guessing USD', () => {
    expect(formatPricingAmount(10, 'PEN')).toMatch(/PEN$/);
    expect(formatPricingAmount(10, 'PEN')).not.toContain('USD');
  });

  it('an unknown currency code still renders (amount + code)', () => {
    expect(formatPricingAmount(10, 'ZZZZ')).toBe('10.00 ZZZZ');
  });

  it('does not change the number it formats', () => {
    const value = 40.4803;
    formatPricingAmount(value, null);
    expect(value).toBe(40.4803);
  });
});
