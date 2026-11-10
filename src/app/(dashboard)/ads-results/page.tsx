'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdsReport, MetaAdInfo, ProductAdRow } from '@/lib/meta-capi/report'
import { AdsResultsByAd } from './ads-results-by-ad'
import { MetaAdsPerformance } from './meta-ads-performance'

const RANGES = [7, 30, 90] as const
const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/**
 * Resultados por anuncio — read-only and isolated (own route, no existing screen changed). Orders are CONFIRMED orders, not collected sales: the
 * "ventas verificadas" and ROAS columns are shown as not available until InkaClick reports payment and ad spend exists.
 */
export default function AdsResultsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const [report, setReport] = useState<AdsReport | null>(null)
  const [error, setError] = useState<null | 'forbidden' | 'failed'>(null)
  // Which product rows are expanded (by product name) and whether the user toggled the full per-ad table (null = default for this report).
  const [openProducts, setOpenProducts] = useState<ReadonlySet<string>>(new Set())
  const [fullAdsOverride, setFullAdsOverride] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    setReport(null)
    setError(null)
    setOpenProducts(new Set())
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

  // The drilldown needs both the product table and the breakdown. Without it the full per-ad table starts OPEN (exactly the previous screen).
  const hasDrilldown = !!report?.ad_breakdown_available && !!report?.product_sales
  const fullAdsOpen = fullAdsOverride ?? !hasDrilldown

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Resultados por anuncio</h1>
        <div className="flex gap-1" role="group" aria-label="Periodo">
          {RANGES.map((d) => (
            <Button key={d} size="sm" variant={d === days ? 'default' : 'outline'} onClick={() => setDays(d)}>
              {d} días
            </Button>
          ))}
        </div>
      </div>

      {error === 'forbidden' && <p className="text-sm text-muted-foreground">No tienes permisos para ver los resultados de anuncios.</p>}
      {error === 'failed' && <p className="text-sm text-destructive">No se pudo cargar el reporte.</p>}
      {!report && !error && <Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" />}

      {report && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="capi-status">
            {report.meta_capi?.enabled
              ? `Envío de conversiones a Meta: activo${report.meta_capi.test_mode ? ' (modo de prueba)' : ''}.`
              : 'Envío de conversiones a Meta: desactivado. Este reporte funciona igual.'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Contactos atribuidos" value={String(report.totals.contacts)} />
            <Stat label="Pedidos confirmados (con anuncio)" value={String(report.totals.attributed_orders)} />
            <Stat label="Pedidos sin atribución comprobable" value={String(report.totals.unattributed_orders)} />
            <Stat label="Importe de pedidos confirmados" value={money(report.totals.order_amount)} />
          </div>

          {report.product_sales && (
            <Card data-testid="sold-products">
              <CardHeader>
                <CardTitle className="text-base">Rendimiento por producto</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {report.product_sales.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sin pedidos confirmados en este periodo.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Producto vendido</TableHead>
                        <TableHead className="text-right">Compradores</TableHead>
                        <TableHead className="text-right">Pedidos</TableHead>
                        <TableHead className="text-right">Unidades</TableHead>
                        <TableHead className="text-right">Ventas confirmadas</TableHead>
                        <TableHead className="text-right">Ticket prom.</TableHead>
                        {hasDrilldown && <TableHead className="text-right">Anuncios atribuidos</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.product_sales.map((p) => {
                        const key = p.product.toLowerCase()
                        const open = openProducts.has(key)
                        const realAds = (p.ads ?? []).filter((a) => a.source_id !== null).length
                        return (
                          <Fragment key={key}>
                            <TableRow>
                              <TableCell className="font-medium">{p.product}</TableCell>
                              <TableCell className="text-right">{p.buyers}</TableCell>
                              <TableCell className="text-right">{p.orders}</TableCell>
                              <TableCell className="text-right">{p.units}</TableCell>
                              <TableCell className="text-right">{money(p.sales)}</TableCell>
                              <TableCell className="text-right">{p.avg_ticket === null ? '—' : money(p.avg_ticket)}</TableCell>
                              {hasDrilldown && (
                                <TableCell className="text-right">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-expanded={open}
                                    aria-label={`Ver anuncios de ${p.product}`}
                                    onClick={() => setOpenProducts((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })}
                                  >
                                    {open ? <ChevronDown className="mr-1 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-1 h-4 w-4" aria-hidden />}
                                    Ver anuncios ({realAds})
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                            {hasDrilldown && open && (
                              <TableRow data-testid="product-ads">
                                <TableCell colSpan={7} className="bg-muted/30">
                                  <AdBreakdown ads={p.ads ?? []} />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  Producto vendido, no necesariamente producto publicitado. Todos los pedidos confirmados del periodo, con o sin anuncio; las ventas son importes de
                  pedidos confirmados (no cobrados) tomados de las líneas del pedido, y en pedidos antiguos sin detalle, del importe del pedido.
                </p>
              </CardContent>
            </Card>
          )}

          <AdsResultsByAd ads={report.ads} open={fullAdsOpen} onToggle={() => setFullAdsOverride(!fullAdsOpen)} />

          {report.meta_ads?.configured && <MetaAdsPerformance days={days} />}

          {report.meta_catalog?.available && report.meta_catalog.synced_at && (
            <p className="text-xs text-muted-foreground" data-testid="meta-catalog-note">
              Nombres de anuncios, campañas y conjuntos de Meta sincronizados el {new Date(report.meta_catalog.synced_at).toLocaleString('es-PE')}. Los números de este reporte
              provienen de WACRM.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Los importes son pedidos confirmados, no ventas cobradas. {report.verified_sales.reason} ROAS no disponible: {report.roas.reason} Conversión = contactos del
            anuncio que pidieron ÷ contactos del anuncio en el periodo.
          </p>
        </>
      )}
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Activo', PAUSED: 'Pausado', ARCHIVED: 'Archivado', DELETED: 'Eliminado' }

/**
 * Ad name + technical id. With the Meta catalog synced (meta !== undefined) the REAL ad name leads and the Meta Ad ID stays small below it;
 * an ad missing from the catalog says so (never guessed from the headline). Without the catalog (meta undefined) it is exactly the previous
 * rendering: headline (or "Sin título") and the id.
 */
function AdIdentity({ sourceId, headline, meta }: { sourceId: string | null; headline: string | null; meta?: MetaAdInfo | null }) {
  const name = meta === undefined ? (headline ?? 'Sin título') : meta === null ? 'Anuncio no sincronizado' : (meta.name ?? headline ?? 'Sin título')
  const detail = meta
    ? [meta.campaign_name && `Campaña: ${meta.campaign_name}`, meta.adset_name && `Conjunto: ${meta.adset_name}`, (STATUS_LABEL[meta.effective_status ?? meta.status ?? ''] ?? null)]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <>
      <div className="font-medium">{name}</div>
      <div className="text-xs text-muted-foreground">ID {sourceId}</div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

function AdBreakdown({ ads }: { ads: ProductAdRow[] }) {
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Anuncio atribuido</TableHead>
            <TableHead className="text-right">Contactos del anuncio</TableHead>
            <TableHead className="text-right">Compradores del producto</TableHead>
            <TableHead className="text-right">Pedidos del producto</TableHead>
            <TableHead className="text-right">Unidades del producto</TableHead>
            <TableHead className="text-right">Ventas confirmadas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ads.map((a) => (
            <TableRow key={a.source_id ?? '__none__'}>
              <TableCell>
                {a.source_id === null ? (
                  <div className="font-medium">Sin atribución comprobable</div>
                ) : (
                  <AdIdentity sourceId={a.source_id} headline={a.headline} meta={a.meta} />
                )}
              </TableCell>
              <TableCell className="text-right">{a.contacts === null ? '—' : a.contacts}</TableCell>
              <TableCell className="text-right">{a.buyers}</TableCell>
              <TableCell className="text-right">{a.orders}</TableCell>
              <TableCell className="text-right">{a.units}</TableCell>
              <TableCell className="text-right">{money(a.sales)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Los contactos corresponden al total del anuncio en el período. No representan necesariamente consultas por este producto. Pedidos, unidades y ventas suman el
        total del producto; Compradores puede sumar más que los compradores únicos del producto si una misma persona compró este producto en pedidos atribuidos a anuncios
        distintos.
      </p>
    </div>
  )
}
