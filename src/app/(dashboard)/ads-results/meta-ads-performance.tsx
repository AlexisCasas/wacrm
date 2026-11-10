'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { MetaPerformance, MetaPerformanceAvailable, PerfMetrics, PerfRow, SyncState } from '@/lib/meta-ads/performance'

// "Rendimiento Meta Ads": spend / impressions / clicks / CTR / CPC / CPM per campaign, ad set and ad, straight from the cached Meta insights
// (/api/ads/meta-performance). Independent of the WACRM report: if it cannot load it renders NOTHING and the rest of the page is unaffected.
// Rows are keyed by Meta ids; names are display only. Reach is not shown (it cannot be summed across days).

const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const int = (n: number) => new Intl.NumberFormat('es-PE').format(n)
const pct = (n: number | null) => (n === null ? '—' : `${money(n)}%`)
const cost = (n: number | null) => (n === null ? '—' : money(n))
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('es-PE')

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

function Metrics({ m }: { m: PerfMetrics }) {
  return (
    <>
      <TableCell className="text-right">{money(m.spend)}</TableCell>
      <TableCell className="text-right">{int(m.impressions)}</TableCell>
      <TableCell className="text-right">{int(m.clicks)}</TableCell>
      <TableCell className="text-right">{pct(m.ctr)}</TableCell>
      <TableCell className="text-right">{cost(m.cpc)}</TableCell>
      <TableCell className="text-right">{cost(m.cpm)}</TableCell>
    </>
  )
}
const METRIC_HEADS = ['Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM']
const MetricHeads = () => (
  <>
    {METRIC_HEADS.map((h) => (
      <TableHead key={h} className="text-right">{h}</TableHead>
    ))}
  </>
)

function PerfTable({ view, data }: { view: View; data: MetaPerformanceAvailable }) {
  const rows: PerfRow[] = data[view]
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin gasto ni impresiones en este período.</p>
  return (
    <Table data-testid={`meta-table-${view}`}>
      <TableHeader>
        <TableRow>
          {view === 'campaigns' && (<><TableHead>Campaña</TableHead><TableHead>Estado</TableHead></>)}
          {view === 'adsets' && (<><TableHead>Conjunto de anuncios</TableHead><TableHead>Campaña</TableHead><TableHead>Estado</TableHead></>)}
          {view === 'ads' && (<><TableHead>Anuncio</TableHead><TableHead>Ad ID</TableHead><TableHead>Campaña</TableHead><TableHead>Conjunto</TableHead><TableHead>Estado</TableHead></>)}
          <MetricHeads />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            {view === 'campaigns' && (
              <>
                <TableCell><div className="font-medium">{r.name ?? 'Campaña sin nombre'}</div><div className="text-xs text-muted-foreground">ID {r.id}</div></TableCell>
                <TableCell>{statusLabel(r.status)}</TableCell>
              </>
            )}
            {view === 'adsets' && (
              <>
                <TableCell><div className="font-medium">{r.name ?? 'Conjunto sin nombre'}</div><div className="text-xs text-muted-foreground">ID {r.id}</div></TableCell>
                <TableCell>{r.campaign_name ?? '—'}</TableCell>
                <TableCell>{statusLabel(r.status)}</TableCell>
              </>
            )}
            {view === 'ads' && (
              <>
                <TableCell className="font-medium">{r.name ?? 'Anuncio no sincronizado'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.id}</TableCell>
                <TableCell>{r.campaign_name ?? '—'}</TableCell>
                <TableCell>{r.adset_name ?? '—'}</TableCell>
                <TableCell>{statusLabel(r.status)}</TableCell>
              </>
            )}
            <Metrics m={r} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function MetaAdsPerformance({ days }: { days: number }) {
  // The response is stored together with the period it answers, so a stale period is never rendered while the next one loads.
  const [loaded, setLoaded] = useState<{ days: number; body: MetaPerformance | null } | null>(null)
  const [view, setView] = useState<View>('campaigns')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ads/meta-performance?days=${days}`)
        const body = res.ok ? ((await res.json()) as MetaPerformance) : null
        if (!cancelled) setLoaded({ days, body })
      } catch {
        if (!cancelled) setLoaded({ days, body: null })
      }
    })()
    return () => { cancelled = true }
  }, [days])

  const data = loaded && loaded.days === days ? loaded.body : null
  if (!data || !data.available) return null // not configured / not synced / unavailable: the section is simply not offered
  const t = data.totals
  return (
    <Card data-testid="meta-performance">
      <CardHeader>
        <CardTitle className="text-base">Rendimiento Meta Ads</CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="meta-sync-status">
          Actualizado al {new Date(data.synced_at).toLocaleString('es-PE')} · {SYNC_TEXT[data.sync.state]}
        </p>
        <p className="text-xs text-muted-foreground">
          Período: {day(data.period.since)} al {day(data.period.until)} ({data.period.days} días completos, {data.period.timezone}). Importes en {data.period.currency}. Datos de Meta, no de WACRM.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 overflow-x-auto">
        {data.sync.partial && (
          <p className="text-xs text-destructive" data-testid="meta-partial">
            Datos parciales: lo guardado cubre {data.sync.covered_from ? day(data.sync.covered_from) : '—'} a {data.sync.covered_to ? day(data.sync.covered_to) : '—'}.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6" data-testid="meta-totals">
          {[['Gasto', money(t.spend)], ['Impresiones', int(t.impressions)], ['Clics', int(t.clicks)], ['CTR', pct(t.ctr)], ['CPC', cost(t.cpc)], ['CPM', cost(t.cpm)]].map(([l, v]) => (
            <div key={l} className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{l}</div><div className="text-lg font-semibold">{v}</div></div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Vista Meta Ads">
          {VIEWS.map((v) => (
            <Button key={v.key} size="sm" variant={v.key === view ? 'default' : 'outline'} aria-pressed={v.key === view} onClick={() => setView(v.key)}>{v.label}</Button>
          ))}
        </div>
        <PerfTable view={view} data={data} />
        <p className="text-xs text-muted-foreground">
          CTR = clics ÷ impresiones; CPC = gasto ÷ clics; CPM = gasto ÷ impresiones × 1000, calculados sobre los totales de cada fila. El alcance no se muestra porque no se puede sumar entre días.
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
