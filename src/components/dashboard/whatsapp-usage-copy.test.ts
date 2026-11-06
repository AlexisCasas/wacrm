import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// User-facing wording of the WhatsApp usage block, the header allowance and the breakdown button. Wording only: no number or calculation depends on it.
const load = (locale: 'es' | 'en') =>
  JSON.parse(readFileSync(join(__dirname, `../../../messages/${locale}.json`), 'utf8')).Dashboard.whatsappUsage as Record<string, string>;
const es = load('es');
const en = load('en');

describe('WhatsApp usage copy', () => {
  it('Spanish wording', () => {
    expect(es).toMatchObject({
      title: 'Uso y costos de WhatsApp',
      description: 'Resumen de mensajes gratuitos, mensajes con costo y gasto estimado.',
      periodCurrentMonth: 'Este mes · actualización automática',
      paidMessages: 'Mensajes con costo',
      paidMessagesHint: 'Mensajes por los que Meta aplica un cobro.',
      estimatedCost: 'Costo estimado',
      estimatedCostHint: 'Gasto acumulado de estos mensajes durante el periodo.',
      freeCustomerService: 'Mensajes gratis de atención',
      freeCustomerServiceHint: 'Mensajes de atención al cliente que Meta no cobró.',
      freeEntryPoint: 'Mensajes gratis desde Meta',
      freeEntryPointHint: 'Mensajes sin costo originados desde anuncios u otros accesos de Meta.',
      viewDetail: 'Ver desglose',
      freeTierLabel: 'Cupo gratuito mensual',
    });
  });

  it('English has exactly the same keys (none missing, none left over)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it('does not claim that every free entry point comes from ads', () => {
    expect(es.freeEntryPointHint).toMatch(/anuncios u otros accesos/);
    expect(en.freeEntryPointHint).toMatch(/ads or other Meta entry points/);
  });

  it('no old technical wording or time-zone text is left in either language', () => {
    const all = JSON.stringify([es, en]);
    expect(all).not.toMatch(/America\/Lima|Punto de acceso|Free entry point|Mensajes pagados|Paid messages|Bolsa|Meta no informó|noCurrency/);
  });
});
