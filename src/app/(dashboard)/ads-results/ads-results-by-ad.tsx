'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdsReport, MetaAdInfo } from '@/lib/meta-capi/report'

// "Detalle por anuncio" (formerly "Vista completa por anuncio"; the page title stays "Resultados por anuncio"): the WACRM commercial view of each attributed ad. PRESENTATION ONLY: every value shown here is
// exactly what the report already carried (no new query, no new metric, nothing from "Rendimiento Meta Ads"). Local to /ads-results; no shared component is touched.

type AdRow = AdsReport['ads'][number]

const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const int = (n: number) => new Intl.NumberFormat('es-PE').format(n)
const NUM = 'whitespace-nowrap text-right tabular-nums'

/** Ad name. EXACTLY the previous logic: with the Meta catalog synced the real name (or "Anuncio no sincronizado" when the ad is not in it); without the catalog the headline. */
export function adName(headline: string | null, meta?: MetaAdInfo | null): string {
  return meta === undefined ? (headline ?? 'Sin título') : meta === null ? 'Anuncio no sincronizado' : (meta.name ?? headline ?? 'Sin título')
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'muted' | 'warn' }> = {
  ACTIVE: { label: 'Activo', tone: 'ok' },
  PAUSED: { label: 'Pausado', tone: 'muted' },
  CAMPAIGN_PAUSED: { label: 'Campaña pausada', tone: 'muted' },
  ADSET_PAUSED: { label: 'Conjunto pausado', tone: 'muted' },
  WITH_ISSUES: { label: 'Con incidencias', tone: 'warn' },
  ARCHIVED: { label: 'Archivado', tone: 'muted' },
  DELETED: { label: 'Eliminado', tone: 'muted' },
}
const TONE = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  warn: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
}
/** Status that the row ALREADY carries (meta.effective_status ?? meta.status). Unknown or missing => no badge (nothing is invented). */
export function adStatus(meta?: MetaAdInfo | null) {
  return meta ? (STATUS[meta.effective_status ?? meta.status ?? ''] ?? null) : null
}

export const PRODUCTS_VISIBLE = 2
/** Few products: all of them. Many: the first PRODUCTS_VISIBLE and "+N más". Order and content are untouched. */
export function splitProducts<T>(products: T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || products.length <= PRODUCTS_VISIBLE + 1) return { shown: products, hidden: 0 }
  return { shown: products.slice(0, PRODUCTS_VISIBLE), hidden: products.length - PRODUCTS_VISIBLE }
}

function Products({ products }: { products: AdRow['products'] }) {
  const [expanded, setExpanded] = useState(false)
  if (products.length === 0) return <span className="text-muted-foreground">—</span>
  const { shown, hidden } = splitProducts(products, expanded)
  return (
    <div className="flex max-w-[22rem] flex-wrap items-center gap-1" data-testid="ad-products">
      {shown.map((p) => (
        <span key={p.name} className="rounded-md bg-muted px-1.5 py-0.5 text-xs leading-tight" title={`${p.name} ×${p.units}`}>
          {p.name} ×{p.units}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={false} onClick={() => setExpanded(true)}>
          +{hidden} más · Ver todos
        </button>
      )}
      {expanded && products.length > PRODUCTS_VISIBLE + 1 && (
        <button type="button" className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded onClick={() => setExpanded(false)}>
          Ver menos
        </button>
      )}
    </div>
  )
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words text-sm">{children}</div>
    </div>
  )
}

export function AdsResultsByAd({ ads, open, onToggle }: { ads: AdRow[]; open: boolean; onToggle: () => void }) {
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set())
  const toggleDetail = (id: string) => setDetails((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <Card data-testid="full-ads">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <button type="button" className="flex items-center gap-1 text-left" aria-expanded={open} aria-controls="full-ads-body" onClick={onToggle}>
            {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
            Detalle por anuncio
          </button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">Resultados comerciales atribuidos a cada anuncio.</p>
      </CardHeader>
      {open && (
        <CardContent className="overflow-x-auto" id="full-ads-body">
          {ads.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin contactos ni pedidos atribuidos a anuncios en este periodo.</p>
          ) : (
            <>
              <Table className="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[14rem]">Anuncio</TableHead>
                    <TableHead className={NUM}>Contactos</TableHead>
                    <TableHead className={NUM}>Pedidos</TableHead>
                    <TableHead className={NUM}>Importe pedidos</TableHead>
                    <TableHead className={NUM}>Unidades</TableHead>
                    <TableHead className={NUM}>Conversión</TableHead>
                    <TableHead>Productos</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ads.map((a) => {
                    const id = a.source_id ?? '__none__'
                    const name = adName(a.headline, a.meta)
                    const status = adStatus(a.meta)
                    const isOpen = details.has(id)
                    return (
                      <Fragment key={id}>
                        <TableRow className="align-top hover:bg-muted/40">
                          <TableCell className="max-w-[22rem] py-3">
                            <div className="line-clamp-2 font-medium leading-snug" title={name}>{name}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-mono text-xs text-muted-foreground" title="Meta Ad ID / source_id">{a.source_id}</span>
                              {status && <span className={`rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4 ${TONE[status.tone]}`} data-testid="ad-status">{status.label}</span>}
                            </div>
                            <button
                              type="button"
                              className="mt-1 flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                              aria-expanded={isOpen}
                              aria-label={`Ver detalle de ${name}`}
                              onClick={() => toggleDetail(id)}
                            >
                              {isOpen ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
                              Ver detalle
                            </button>
                          </TableCell>
                          <TableCell className={`${NUM} py-3`}>{int(a.contacts)}</TableCell>
                          <TableCell className={`${NUM} py-3`}>{int(a.orders)}</TableCell>
                          <TableCell className={`${NUM} py-3`}>{money(a.order_amount)}</TableCell>
                          <TableCell className={`${NUM} py-3`}>{int(a.units)}</TableCell>
                          <TableCell className={`${NUM} py-3`}>{a.conversion_pct === null ? '—' : `${a.conversion_pct.toFixed(1)}%`}</TableCell>
                          <TableCell className="py-3"><Products products={a.products} /></TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow data-testid="ad-detail-row">
                            <TableCell colSpan={7} className="bg-muted/30">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid={`ad-detail-${id}`}>
                                <DetailItem label="Meta Ad ID / source_id"><span className="font-mono">{a.source_id}</span></DetailItem>
                                {a.meta && <DetailItem label="Campaña">{a.meta.campaign_name ?? '—'}</DetailItem>}
                                {a.meta && <DetailItem label="Conjunto">{a.meta.adset_name ?? '—'}</DetailItem>}
                                {a.meta && <DetailItem label="Estado">{status?.label ?? '—'}</DetailItem>}
                                <DetailItem label="Ventas verificadas">No disponible</DetailItem>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">Los productos corresponden a productos vendidos, no necesariamente al producto publicitado.</p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
