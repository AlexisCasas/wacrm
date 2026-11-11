'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Loader2, ShoppingCart, Unlink, Users, Wallet } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import type { AdsReport } from '@/lib/meta-capi/report'
import { AdsResultsByAd } from './ads-results-by-ad'
import { AdsResultsByProduct } from './ads-results-by-product'
import { MetaAdsPerformance } from './meta-ads-performance'
import { useMetaPerformance } from './use-meta-performance'

const RANGES = [7, 30, 90] as const
const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

type View = 'ads' | 'products'

/**
 * Resultados por anuncio — read-only and isolated (own route, no existing screen changed). Orders are CONFIRMED orders, not collected sales: the
 * "ventas verificadas" and ROAS figures are shown as not available until InkaClick reports payment and ad spend exists.
 * Reading order: summary -> "Detalle por anuncio" (or "Por producto") -> Meta's own global performance (separate card, clearly labelled as Meta's data).
 */
export default function AdsResultsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const [report, setReport] = useState<AdsReport | null>(null)
  const [error, setError] = useState<null | 'forbidden' | 'failed'>(null)
  const [view, setView] = useState<View>('ads')

  const load = useCallback(async () => {
    setReport(null)
    setError(null)
    const to = new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    try {
      const res = await fetch(`/api/ads/results?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      if (res.status === 401 || res.status === 403) {
        setError('forbidden')
        return
      }
      if (!res.ok) throw new Error('bad status')
      setReport((await res.json()) as AdsReport)
    } catch {
      setError('failed')
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  // Meta's numbers (one fetch, shared by the per-ad detail and the global card). Only asked for when the report says Meta Ads is configured.
  const perf = useMetaPerformance(days, !!report?.meta_ads?.configured)
  // The product view needs the product table; the drilldown additionally needs the breakdown.
  const hasProducts = !!report?.product_sales
  const hasDrilldown = !!report?.ad_breakdown_available && hasProducts
  const current: View = hasProducts ? view : 'ads'

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Resultados por anuncio</h1>
          <p className="mt-1 text-sm text-muted-foreground">Rendimiento comercial de tus anuncios: contactos, pedidos, ventas y productos atribuidos.</p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border bg-card p-1" role="group" aria-label="Periodo">
          <CalendarDays className="ml-2 mr-1 h-4 w-4 text-muted-foreground" aria-hidden />
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === days}
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                d === days ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {d} días
            </button>
          ))}
        </div>
      </div>

      {error === 'forbidden' && <p className="text-sm text-muted-foreground">No tienes permisos para ver los resultados de anuncios.</p>}
      {error === 'failed' && <p className="text-sm text-destructive">No se pudo cargar el reporte.</p>}
      {!report && !error && <Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" />}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={<Users className="h-5 w-5" />} label="Contactos atribuidos" value={String(report.totals.contacts)} />
            <Stat icon={<ShoppingCart className="h-5 w-5" />} label="Pedidos confirmados (con anuncio)" value={String(report.totals.attributed_orders)} />
            <Stat icon={<Wallet className="h-5 w-5" />} label="Importe de pedidos confirmados" value={money(report.totals.order_amount)} />
            <Stat icon={<Unlink className="h-5 w-5" />} label="Pedidos sin atribución comprobable" value={String(report.totals.unattributed_orders)} />
          </div>

          <section className="space-y-3" aria-label="Resultados comerciales">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{current === 'ads' ? 'Detalle por anuncio' : 'Rendimiento por producto'}</h2>
                <p className="text-xs text-muted-foreground">
                  {current === 'ads' ? 'Resultados comerciales atribuidos a cada anuncio.' : 'Todos los pedidos confirmados del periodo, agrupados por producto vendido.'}
                </p>
              </div>
              {hasProducts && (
                <div className="flex gap-1 rounded-xl border bg-card p-1" role="group" aria-label="Vista">
                  {(
                    [
                      ['ads', 'Por anuncio'],
                      ['products', 'Por producto'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={current === key}
                      onClick={() => setView(key)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        current === key ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {current === 'ads' ? <AdsResultsByAd ads={report.ads} perf={perf} /> : <AdsResultsByProduct productSales={report.product_sales ?? []} hasDrilldown={hasDrilldown} />}
          </section>

          {perf && <MetaAdsPerformance data={perf} />}

          {report.meta_catalog?.available && report.meta_catalog.synced_at && (
            <p className="text-xs text-muted-foreground" data-testid="meta-catalog-note">
              Nombres de anuncios, campañas y conjuntos de Meta sincronizados el {new Date(report.meta_catalog.synced_at).toLocaleString('es-PE')}. Los números de este reporte
              provienen de WACRM.
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="capi-status">
            {report.meta_capi?.enabled
              ? `Envío de conversiones a Meta: activo${report.meta_capi.test_mode ? ' (modo de prueba)' : ''}.`
              : 'Envío de conversiones a Meta: desactivado. Este reporte funciona igual.'}
          </p>
          <p className="text-xs text-muted-foreground">
            Los importes son pedidos confirmados, no ventas cobradas. {report.verified_sales.reason} ROAS no disponible: {report.roas.reason} Conversión = contactos del
            anuncio que pidieron ÷ contactos del anuncio en el periodo.
          </p>
        </>
      )}
    </div>
  )
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="py-0">
      <CardContent className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold leading-8 tabular-nums">{value}</div>
        </div>
      </CardContent>
    </Card>
  )
}
