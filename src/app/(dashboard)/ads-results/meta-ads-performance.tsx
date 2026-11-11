'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  MESSAGING_LABELS, MESSAGING_TOOLTIP, minorToMajor,
  type ExtMetrics, type MessagingKey, type MetaPerformanceAvailable, type PerfDetail, type PerfMetrics, type PerfRow, type SyncState,
} from '@/lib/meta-ads/performance'

// "Rendimiento Meta Ads": everything here is what META reports, read from our cache (/api/ads/meta-performance, fetched by the page via useMetaPerformance). Independent of the
// WACRM report: if it cannot load the page does not render this card at all. Rows are keyed by Meta ids; names are display only. Reach / frequency come from Meta's aggregate for the window
// (never a sum of daily reach). When the extended cache is unavailable (data.extended absent) the section is exactly the previous one: no Reach / Frecuencia columns,
// no traffic / messaging groups, no detail rows.

const nf = (min: number, max: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: min, maximumFractionDigits: max })
const money = (n: number) => nf(2, 2).format(n)
const int = (n: number) => new Intl.NumberFormat('es-PE').format(n)
const pct = (n: number | null) => (n === null ? '—' : `${money(n)}%`)
const cost = (n: number | null) => (n === null ? '—' : money(n))
const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : int(n))
const freq = (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf(2, 2).format(n))
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('es-PE')
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('es-PE') : '—')

const STATUS: Record<string, string> = { ACTIVE: 'Activo', PAUSED: 'Pausado', ARCHIVED: 'Archivado', DELETED: 'Eliminado', CAMPAIGN_PAUSED: 'Campaña pausada', ADSET_PAUSED: 'Conjunto pausado', IN_PROCESS: 'En proceso', WITH_ISSUES: 'Con problemas', DISAPPROVED: 'Rechazado', PENDING_REVIEW: 'En revisión' }
const statusLabel = (s: string | null) => (s ? (STATUS[s] ?? s.toLowerCase().replace(/_/g, ' ')) : '—')
const SYNC_TEXT: Record<SyncState, string> = {
  ok: 'Sincronización al día',
  syncing: 'Cargando historial: los períodos largos aún pueden estar incompletos',
  error: 'Error en la última sincronización: se muestran los últimos datos guardados',
  paused: 'Sincronización pausada (revisar credencial de Meta): se muestran los últimos datos guardados',
  pending: 'Sincronización pendiente',
}

type View = 'campaigns' | 'adsets' | 'ads'
const VIEWS: { key: View; label: string }[] = [
  { key: 'campaigns', label: 'Campañas' },
  { key: 'adsets', label: 'Conjuntos de anuncios' },
  { key: 'ads', label: 'Anuncios' },
]
const MESSAGING_KEYS: MessagingKey[] = ['conversations_started', 'connections', 'first_replies', 'depth_2', 'depth_3']

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-2" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}
function Group({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-5">{children}</div>
    </div>
  )
}

function Summary({ t, ext }: { t: PerfMetrics; ext: ExtMetrics | null | undefined }) {
  if (!ext) {
    // checkpoint layout: the six base KPIs
    return (
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6" data-testid="meta-totals">
        {[['Gasto', money(t.spend)], ['Impresiones', int(t.impressions)], ['Clics', int(t.clicks)], ['CTR', pct(t.ctr)], ['CPC', cost(t.cpc)], ['CPM', cost(t.cpm)]].map(([l, v]) => (
          <Kpi key={l} label={l} value={v} />
        ))}
      </div>
    )
  }
  const msg = MESSAGING_KEYS.filter((k) => ext.messaging[k] !== null)
  return (
    <div className="space-y-3" data-testid="meta-totals">
      <Group title="Rendimiento" testId="meta-group-performance">
        <Kpi label="Gasto" value={money(t.spend)} />
        <Kpi label="Impresiones" value={int(t.impressions)} />
        <Kpi label="Reach" value={count(ext.reach)} hint="Personas únicas alcanzadas en el período, según Meta. No se obtiene sumando días." />
        <Kpi label="Frecuencia" value={freq(ext.frequency)} hint="Impresiones ÷ reach del período, según Meta." />
        <Kpi label="CTR" value={pct(t.ctr)} />
        <Kpi label="CPC" value={cost(t.cpc)} />
        <Kpi label="CPM" value={cost(t.cpm)} />
      </Group>
      <Group title="Tráfico" testId="meta-group-traffic">
        <Kpi label="Clics" value={int(t.clicks)} hint="Todos los clics (incluye interacciones fuera del enlace)." />
        <Kpi label="Clics en enlace" value={count(ext.link_clicks)} />
        <Kpi label="Clics salientes" value={count(ext.outbound_clicks)} />
      </Group>
      {msg.length > 0 && (
        <Group title="Mensajería (Meta)" testId="meta-group-messaging">
          {msg.map((k) => (
            <Kpi key={k} label={MESSAGING_LABELS[k]} value={count(ext.messaging[k])} hint={MESSAGING_TOOLTIP} />
          ))}
        </Group>
      )}
    </div>
  )
}

const METRIC_HEADS = (extended: boolean) => (extended ? ['Gasto', 'Impresiones', 'Reach', 'Frecuencia', 'Clics', 'CTR', 'CPC', 'CPM'] : ['Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM'])

function Metrics({ m, extended }: { m: PerfRow; extended: boolean }) {
  return (
    <>
      <TableCell className="text-right">{money(m.spend)}</TableCell>
      <TableCell className="text-right">{int(m.impressions)}</TableCell>
      {extended && <TableCell className="text-right">{count(m.ext?.reach)}</TableCell>}
      {extended && <TableCell className="text-right">{freq(m.ext?.frequency)}</TableCell>}
      <TableCell className="text-right">{int(m.clicks)}</TableCell>
      <TableCell className="text-right">{pct(m.ctr)}</TableCell>
      <TableCell className="text-right">{cost(m.cpc)}</TableCell>
      <TableCell className="text-right">{cost(m.cpm)}</TableCell>
    </>
  )
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}
function budget(minor: number | null | undefined, currency: string) {
  return minor === null || minor === undefined ? '—' : `${currency} ${money(minorToMajor(minor, currency))}`
}

function DetailPanel({ view, row, currency }: { view: View; row: PerfRow; currency: string }) {
  const d: PerfDetail = row.detail ?? {}
  const ext = row.ext
  return (
    <div className="space-y-3 text-sm" data-testid={`meta-detail-${row.id}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DetailItem label={view === 'campaigns' ? 'ID campaña' : view === 'adsets' ? 'ID conjunto' : 'Ad ID'} value={row.id} />
        {view === 'campaigns' && (
          <>
            <DetailItem label="Objetivo" value={d.objective ?? '—'} />
            <DetailItem label="Tipo de compra" value={d.buying_type ?? '—'} />
            <DetailItem label="Presupuesto diario" value={budget(d.daily_budget, currency)} />
            <DetailItem label="Presupuesto total" value={budget(d.lifetime_budget, currency)} />
            <DetailItem label="Inicio" value={when(d.start_time)} />
            <DetailItem label="Fin" value={when(d.stop_time)} />
            <DetailItem label="Actualizada" value={when(d.updated_time)} />
          </>
        )}
        {view === 'adsets' && (
          <>
            <DetailItem label="Objetivo de optimización" value={d.optimization_goal ?? '—'} />
            <DetailItem label="Evento de facturación" value={d.billing_event ?? '—'} />
            <DetailItem label="Estrategia de puja" value={d.bid_strategy ?? '—'} />
            <DetailItem label="Presupuesto diario" value={budget(d.daily_budget, currency)} />
            <DetailItem label="Presupuesto total" value={budget(d.lifetime_budget, currency)} />
            <DetailItem label="Inicio" value={when(d.start_time)} />
            <DetailItem label="Fin" value={when(d.end_time)} />
            <DetailItem label="Actualizado" value={when(d.updated_time)} />
          </>
        )}
        {view === 'ads' && (
          <>
            <DetailItem label="Creado" value={when(d.created_time)} />
            <DetailItem label="Actualizado" value={when(d.updated_time)} />
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DetailItem label="Clics" value={int(row.clicks)} />
        <DetailItem label="Clics en enlace" value={count(ext?.link_clicks)} />
        <DetailItem label="Clics salientes" value={count(ext?.outbound_clicks)} />
      </div>
      {ext && MESSAGING_KEYS.some((k) => ext.messaging[k] !== null) && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" title={MESSAGING_TOOLTIP}>
          {MESSAGING_KEYS.filter((k) => ext.messaging[k] !== null).map((k) => (
            <DetailItem key={k} label={MESSAGING_LABELS[k]} value={count(ext.messaging[k])} />
          ))}
        </div>
      )}
      {ext && ext.other_results.length > 0 && <OtherResults items={ext.other_results} />}
    </div>
  )
}

function OtherResults({ items }: { items: ExtMetrics['other_results'] }) {
  return (
    <details data-testid="meta-other-results" className="rounded-md border p-2">
      <summary className="cursor-pointer text-xs font-medium">Otros resultados Meta ({items.length})</summary>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Descripción</TableHead>
            <TableHead>action_type</TableHead>
            <TableHead className="text-right">Valor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((o) => (
            <TableRow key={o.action_type}>
              <TableCell>{o.description}</TableCell>
              <TableCell className="font-mono text-xs">{o.action_type}</TableCell>
              <TableCell className="text-right">{int(o.value)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {items.filter((o) => o.lead_alias).length > 1 && (
        <p className="mt-1 text-xs text-muted-foreground">Los action_type de tipo lead pueden describir el mismo evento con distintos nombres: se muestran por separado y no se suman.</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">Resultados reportados por Meta. No son contactos, pedidos ni ventas de WACRM.</p>
    </details>
  )
}

function PerfTable({ view, data }: { view: View; data: MetaPerformanceAvailable }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const rows: PerfRow[] = data[view]
  const extended = !!data.extended?.available
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin gasto ni impresiones en este período.</p>
  const lead = view === 'campaigns' ? 2 : view === 'adsets' ? 3 : 5
  const cols = lead + METRIC_HEADS(extended).length
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const expander = (r: PerfRow) =>
    extended ? (
      <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" aria-expanded={open.has(r.id)} aria-label={`Detalle de ${r.name ?? r.id}`} onClick={() => toggle(r.id)}>
        {open.has(r.id) ? <ChevronDown className="mr-1 h-3 w-3" aria-hidden /> : <ChevronRight className="mr-1 h-3 w-3" aria-hidden />}
        Detalle
      </Button>
    ) : null
  return (
    <Table data-testid={`meta-table-${view}`}>
      <TableHeader>
        <TableRow>
          {view === 'campaigns' && (<><TableHead>Campaña</TableHead><TableHead>Estado</TableHead></>)}
          {view === 'adsets' && (<><TableHead>Conjunto de anuncios</TableHead><TableHead>Campaña</TableHead><TableHead>Estado</TableHead></>)}
          {view === 'ads' && (<><TableHead>Anuncio</TableHead><TableHead>Ad ID</TableHead><TableHead>Campaña</TableHead><TableHead>Conjunto</TableHead><TableHead>Estado</TableHead></>)}
          {METRIC_HEADS(extended).map((h) => (
            <TableHead key={h} className="text-right">{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <Fragment key={r.id}>
            <TableRow>
              {view === 'campaigns' && (
                <>
                  <TableCell><div className="font-medium">{r.name ?? 'Campaña sin nombre'}</div><div className="text-xs text-muted-foreground">ID {r.id}</div>{expander(r)}</TableCell>
                  <TableCell>{statusLabel(r.status)}</TableCell>
                </>
              )}
              {view === 'adsets' && (
                <>
                  <TableCell><div className="font-medium">{r.name ?? 'Conjunto sin nombre'}</div><div className="text-xs text-muted-foreground">ID {r.id}</div>{expander(r)}</TableCell>
                  <TableCell>{r.campaign_name ?? '—'}</TableCell>
                  <TableCell>{statusLabel(r.status)}</TableCell>
                </>
              )}
              {view === 'ads' && (
                <>
                  <TableCell><div className="font-medium">{r.name ?? 'Anuncio no sincronizado'}</div>{expander(r)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.id}</TableCell>
                  <TableCell>{r.campaign_name ?? '—'}</TableCell>
                  <TableCell>{r.adset_name ?? '—'}</TableCell>
                  <TableCell>{statusLabel(r.status)}</TableCell>
                </>
              )}
              <Metrics m={r} extended={extended} />
            </TableRow>
            {extended && open.has(r.id) && (
              <TableRow data-testid="meta-detail-row">
                <TableCell colSpan={cols} className="bg-muted/30">
                  <DetailPanel view={view} row={r} currency={data.period.currency} />
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  )
}

export function MetaAdsPerformance({ data }: { data: MetaPerformanceAvailable }) {
  const [view, setView] = useState<View>('campaigns')
  const ext = data.extended?.available ? data.extended.summary : undefined
  return (
    <Card data-testid="meta-performance">
      <CardHeader>
        <CardTitle className="text-base">Rendimiento Meta Ads</CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="meta-sync-status">
          Actualizado al {new Date(data.synced_at).toLocaleString('es-PE')} · {SYNC_TEXT[data.sync.state]}
        </p>
        <p className="text-xs text-muted-foreground">
          Período: {day(data.period.since)} al {day(data.period.until)} ({data.period.days} días completos, {data.period.timezone}). Importes en {data.period.currency}. Datos reportados por Meta, no de WACRM.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 overflow-x-auto">
        {data.sync.partial && (
          <p className="text-xs text-destructive" data-testid="meta-partial">
            Datos parciales: lo guardado cubre {data.sync.covered_from ? day(data.sync.covered_from) : '—'} a {data.sync.covered_to ? day(data.sync.covered_to) : '—'}.
          </p>
        )}
        <Summary t={data.totals} ext={ext} />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Vista Meta Ads">
          {VIEWS.map((v) => (
            <Button key={v.key} size="sm" variant={v.key === view ? 'default' : 'outline'} aria-pressed={v.key === view} onClick={() => setView(v.key)}>{v.label}</Button>
          ))}
        </div>
        <PerfTable key={view} view={view} data={data} />
        {ext && ext.other_results.length > 0 && <OtherResults items={ext.other_results} />}
        <p className="text-xs text-muted-foreground">
          CTR = clics ÷ impresiones; CPC = gasto ÷ clics; CPM = gasto ÷ impresiones × 1000, calculados sobre los totales de cada fila.
          {data.extended?.available
            ? ' Reach y frecuencia son los valores agregados de Meta para el período completo (no se pueden sumar entre días ni entre anuncios, por eso los totales de cada nivel pueden diferir).'
            : ' El alcance no se muestra porque no se puede sumar entre días.'}
          {data.reconciliation
            ? data.reconciliation.ok
              ? ` Conciliado con Meta (${day(data.reconciliation.date_from)} al ${day(data.reconciliation.date_to)}) el ${new Date(data.reconciliation.checked_at).toLocaleString('es-PE')}.`
              : ' Hay diferencias con los totales de Meta para este período; en revisión.'
            : ''}
        </p>
      </CardContent>
    </Card>
  )
}
