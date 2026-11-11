'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Coins, Copy, Eye, Info, MousePointerClick, Package, Percent } from 'lucide-react'
import type { AdsReport, MetaAdInfo } from '@/lib/meta-capi/report'
import { MESSAGING_LABELS, MESSAGING_TOOLTIP, type MessagingKey, type MetaPerformanceAvailable, type PerfRow } from '@/lib/meta-ads/performance'

// "Detalle por anuncio": the WACRM commercial view of each attributed ad, as a modern list (not a table of ten columns). PRESENTATION ONLY: every WACRM figure is exactly what the
// report already carried (no new query, formula or metric); the expandable "Rendimiento en Meta Ads" block only shows what the existing Meta cache returned FOR THAT AD
// (keyed by Meta ad id = source_id) and is simply absent when Meta has nothing for it. Local to /ads-results; no shared component is touched.

type AdRow = AdsReport['ads'][number]

const nf = (min: number, max: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: min, maximumFractionDigits: max })
const money = (n: number) => nf(2, 2).format(n)
const int = (n: number) => new Intl.NumberFormat('es-PE').format(n)
const pct = (n: number | null) => (n === null ? '—' : `${money(n)}%`)
const cost = (n: number | null) => (n === null ? '—' : money(n))

/** Ad name. EXACTLY the previous logic: with the Meta catalog synced the real name (or "Anuncio no sincronizado" when the ad is not in it); without the catalog the headline. */
export function adName(headline: string | null, meta?: MetaAdInfo | null): string {
  return meta === undefined ? (headline ?? 'Sin título') : meta === null ? 'Anuncio no sincronizado' : (meta.name ?? headline ?? 'Sin título')
}

type Tone = 'ok' | 'muted' | 'warn'
const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Activo', tone: 'ok' },
  PAUSED: { label: 'Pausado', tone: 'warn' },
  CAMPAIGN_PAUSED: { label: 'Campaña pausada', tone: 'warn' },
  ADSET_PAUSED: { label: 'Conjunto pausado', tone: 'warn' },
  WITH_ISSUES: { label: 'Con incidencias', tone: 'warn' },
  ARCHIVED: { label: 'Archivado', tone: 'muted' },
  DELETED: { label: 'Eliminado', tone: 'muted' },
}
const BADGE: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
}
const DOT: Record<Tone, string> = { ok: 'bg-emerald-500', muted: 'bg-muted-foreground/60', warn: 'bg-amber-500' }
/** Status that the row ALREADY carries (meta.effective_status ?? meta.status). Unknown or missing => no badge (nothing is invented). */
export function adStatus(meta?: MetaAdInfo | null) {
  return meta ? (STATUS[meta.effective_status ?? meta.status ?? ''] ?? null) : null
}
function StatusBadge({ status }: { status: NonNullable<ReturnType<typeof adStatus>> }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${BADGE[status.tone]}`} data-testid="ad-status">
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} aria-hidden />
      {status.label}
    </span>
  )
}

export const PRODUCTS_VISIBLE = 2
/** Up to PRODUCTS_VISIBLE products: all of them. More: the first PRODUCTS_VISIBLE and "+N más". Order and content are untouched. */
export function splitProducts<T>(products: T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || products.length <= PRODUCTS_VISIBLE) return { shown: products, hidden: 0 }
  return { shown: products.slice(0, PRODUCTS_VISIBLE), hidden: products.length - PRODUCTS_VISIBLE }
}

const CHIP = 'max-w-full truncate rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-xs leading-5'
const CHIP_BTN = 'rounded-md px-2 py-0.5 text-xs font-medium leading-5 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Products({ products }: { products: AdRow['products'] }) {
  const [expanded, setExpanded] = useState(false)
  if (products.length === 0) return <span className="text-muted-foreground">—</span>
  const { shown, hidden } = splitProducts(products, expanded)
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="ad-products">
      {shown.map((p) => (
        <span key={p.name} className={CHIP} title={`${p.name} ×${p.units}`}>
          {p.name} ×{p.units}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" className={CHIP_BTN} aria-expanded={false} aria-label={`Ver todos los productos (${hidden} más)`} onClick={() => setExpanded(true)}>
          +{hidden} más
        </button>
      )}
      {expanded && products.length > PRODUCTS_VISIBLE && (
        <button type="button" className={CHIP_BTN} aria-expanded onClick={() => setExpanded(false)}>
          Ver menos
        </button>
      )}
    </div>
  )
}

// ---- expanded detail: three blocks -----------------------------------------------------------------------------------------------------------------------------------------

function Block({ title, icon, note, testId, children }: { title: string; icon: React.ReactNode; note?: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4" data-testid={testId}>
      <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground" aria-hidden>{icon}</span>
        {title}
        {note && <span className="text-xs font-normal text-muted-foreground">{note}</span>}
      </h4>
      {children}
    </section>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
function Tile({ label, value, icon, hint }: { label: string; value: string; icon: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3" title={hint}>
      <span className="text-muted-foreground" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className="text-base font-semibold leading-5 tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
const MESSAGING: MessagingKey[] = ['conversations_started', 'connections', 'first_replies', 'depth_2', 'depth_3']

/** Meta's metrics of THIS ad for the period. Secondary metrics appear only when Meta returned them for the ad (never blank placeholders, never account totals). */
function MetaBlock({ row, perf }: { row: PerfRow | undefined; perf: MetaPerformanceAvailable }) {
  const days = perf.period.days
  const ext = row?.ext
  const more: { label: string; value: string; hint?: string }[] = []
  if (row && ext) {
    if (ext.reach !== null) more.push({ label: 'Reach', value: int(ext.reach), hint: 'Personas únicas alcanzadas en el período, según Meta.' })
    if (ext.frequency !== null) more.push({ label: 'Frecuencia', value: nf(2, 2).format(ext.frequency) })
  }
  if (row) {
    if (row.cpc !== null) more.push({ label: 'CPC', value: cost(row.cpc) })
    if (row.cpm !== null) more.push({ label: 'CPM', value: cost(row.cpm) })
  }
  if (ext) {
    if (ext.link_clicks !== null) more.push({ label: 'Clics en enlace', value: int(ext.link_clicks) })
    if (ext.outbound_clicks !== null) more.push({ label: 'Clics salientes', value: int(ext.outbound_clicks) })
    for (const k of MESSAGING) {
      const v = ext.messaging[k]
      if (v !== null) more.push({ label: MESSAGING_LABELS[k], value: int(v), hint: MESSAGING_TOOLTIP })
    }
  }
  return (
    <Block title="Rendimiento en Meta Ads" note={`(${days} días)`} icon={<Eye className="h-4 w-4" />} testId="ad-meta-block">
      {!row ? (
        <p className="text-sm text-muted-foreground">Meta no reporta gasto ni impresiones de este anuncio en el período.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Impresiones" value={int(row.impressions)} icon={<Eye className="h-4 w-4" />} />
            <Tile label="Clics" value={int(row.clicks)} icon={<MousePointerClick className="h-4 w-4" />} hint="Todos los clics (incluye interacciones fuera del enlace)." />
            <Tile label="CTR" value={pct(row.ctr)} icon={<Percent className="h-4 w-4" />} />
            <Tile label={`Gasto (${perf.period.currency})`} value={money(row.spend)} icon={<Coins className="h-4 w-4" />} />
          </div>
          {more.length > 0 && (
            <details className="group rounded-lg border" data-testid="ad-meta-more">
              <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden />
                Más métricas de Meta ({more.length})
              </summary>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 border-t px-3 py-2 sm:grid-cols-2">
                {more.map((m) => (
                  <div key={m.label} className="flex items-baseline justify-between gap-2 text-xs" title={m.hint}>
                    <dt className="text-muted-foreground">{m.label}</dt>
                    <dd className="font-medium tabular-nums">{m.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-4 text-muted-foreground">Datos reportados por Meta (no son contactos ni pedidos de WACRM).</p>
    </Block>
  )
}

function CopyId({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
      aria-label={done ? 'ID copiado' : 'Copiar ID del anuncio'}
      title={done ? 'Copiado' : 'Copiar'}
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(value)
          setDone(true)
        } catch {
          /* clipboard unavailable: nothing to do */
        }
      }}
    >
      <Copy className="h-3 w-3" aria-hidden />
    </button>
  )
}

function AdDetail({ ad, id, status, perf, perfRow }: { ad: AdRow; id: string; status: ReturnType<typeof adStatus>; perf: MetaPerformanceAvailable | null; perfRow: PerfRow | undefined }) {
  return (
    <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:px-4 sm:pb-4 lg:grid-cols-3" data-testid="ad-detail-row">
      <Block title="Información del anuncio" icon={<Info className="h-4 w-4" />} testId={`ad-detail-${id}`}>
        <dl className="space-y-2">
          <Field label="Meta Ad ID">
            <span className="font-mono text-xs">{ad.source_id}</span>
            {ad.source_id && <CopyId value={ad.source_id} />}
          </Field>
          {ad.meta && <Field label="Campaña">{ad.meta.campaign_name ?? '—'}</Field>}
          {ad.meta && <Field label="Conjunto">{ad.meta.adset_name ?? '—'}</Field>}
          {ad.meta && <Field label="Estado">{status ? <StatusBadge status={status} /> : '—'}</Field>}
          <Field label="Ventas verificadas">
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">No disponible</span>
          </Field>
        </dl>
      </Block>
      {perf && <MetaBlock row={perfRow} perf={perf} />}
      <Block title="Productos atribuidos" note="(todos)" icon={<Package className="h-4 w-4" />} testId="ad-products-block">
        {ad.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin productos vendidos en este período.</p>
        ) : (
          <ul className="divide-y text-sm">
            {ad.products.map((p) => (
              <li key={p.name} className="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                <span className="min-w-0 break-words">{p.name}</span>
                <span className="shrink-0 font-medium tabular-nums">×{p.units}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  )
}

// ---- main list ------------------------------------------------------------------------------------------------------------------------------------------------------------------

// Desktop: Anuncio | Contactos | Pedidos | Venta | Productos | chevron. Below lg each ad is a compact vertical block (labels appear inline).
const GRID = 'lg:grid-cols-[minmax(0,2.4fr)_4.5rem_minmax(7rem,1fr)_minmax(8rem,1.1fr)_minmax(0,2fr)_2rem]'
const MOBILE_LABEL = 'text-[11px] uppercase tracking-wide text-muted-foreground lg:hidden'

export function AdsResultsByAd({ ads, perf }: { ads: AdRow[]; perf?: MetaPerformanceAvailable | null }) {
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set())
  const toggleDetail = (id: string) => setDetails((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const perfById = new Map((perf?.ads ?? []).map((r) => [r.id, r]))

  if (ads.length === 0) return <p className="text-sm text-muted-foreground" data-testid="full-ads">Sin contactos ni pedidos atribuidos a anuncios en este periodo.</p>
  return (
    <div data-testid="full-ads">
      <div role="table" aria-label="Detalle por anuncio" className="overflow-hidden rounded-xl border bg-card">
        <div role="rowgroup" className="hidden bg-muted/50 lg:block">
          <div role="row" className={`grid items-center gap-x-4 px-4 py-2.5 text-xs font-medium text-muted-foreground ${GRID}`}>
            <div role="columnheader">Anuncio</div>
            <div role="columnheader" className="text-center">Contactos</div>
            <div role="columnheader">Pedidos</div>
            <div role="columnheader">Venta</div>
            <div role="columnheader">Productos</div>
            <div role="columnheader" className="sr-only">Detalle</div>
          </div>
        </div>
        <div role="rowgroup" className="divide-y">
          {ads.map((a) => {
            const id = a.source_id ?? '__none__'
            const name = adName(a.headline, a.meta)
            const status = adStatus(a.meta)
            const isOpen = details.has(id)
            return (
              <div key={id} className={isOpen ? 'bg-muted/30' : 'transition-colors hover:bg-muted/30'} data-testid="ad-item">
                <div role="row" className={`relative grid grid-cols-3 items-start gap-x-4 gap-y-3 px-4 py-4 lg:items-center ${GRID}`}>
                  <div role="cell" className="col-span-3 min-w-0 pr-8 lg:col-span-1 lg:pr-0">
                    <div className="line-clamp-2 text-sm font-semibold leading-snug" title={name}>{name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs text-muted-foreground" title="Meta Ad ID / source_id">ID: {a.source_id}</span>
                      {status && <StatusBadge status={status} />}
                    </div>
                  </div>
                  <div role="cell" className="text-left tabular-nums lg:text-center">
                    <div className={MOBILE_LABEL}>Contactos</div>
                    <div className="text-lg font-semibold leading-6">{int(a.contacts)}</div>
                  </div>
                  <div role="cell" className="tabular-nums">
                    <div className={MOBILE_LABEL}>Pedidos</div>
                    <div className="text-sm font-semibold">{int(a.orders)} {a.orders === 1 ? 'pedido' : 'pedidos'}</div>
                    <div className="text-xs text-muted-foreground">{int(a.units)} {a.units === 1 ? 'unidad' : 'unidades'}</div>
                  </div>
                  <div role="cell" className="tabular-nums">
                    <div className={MOBILE_LABEL}>Venta</div>
                    <div className="text-sm font-semibold">{money(a.order_amount)}</div>
                    <div className="text-xs text-muted-foreground">{a.conversion_pct === null ? '— conversión' : `${a.conversion_pct.toFixed(1)}% conversión`}</div>
                  </div>
                  <div role="cell" className="col-span-3 min-w-0 lg:col-span-1">
                    <div className={`${MOBILE_LABEL} mb-1`}>Productos</div>
                    <Products products={a.products} />
                  </div>
                  <div role="cell" className="absolute right-3 top-3 lg:static lg:flex lg:justify-end">
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={isOpen}
                      aria-label={`Ver detalle de ${name}`}
                      onClick={() => toggleDetail(id)}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    </button>
                  </div>
                </div>
                {isOpen && <AdDetail ad={a} id={id} status={status} perf={perf ?? null} perfRow={a.source_id ? perfById.get(a.source_id) : undefined} />}
              </div>
            )
          })}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Los productos corresponden a productos vendidos, no necesariamente al producto publicitado.</p>
    </div>
  )
}
