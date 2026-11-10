'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdsReport } from '@/lib/meta-capi/report'

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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Por anuncio</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {report.ads.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin contactos ni pedidos atribuidos a anuncios en este periodo.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Anuncio</TableHead>
                      <TableHead className="text-right">Contactos</TableHead>
                      <TableHead className="text-right">Pedidos</TableHead>
                      <TableHead className="text-right">Importe pedidos</TableHead>
                      <TableHead className="text-right">Unidades</TableHead>
                      <TableHead className="text-right">Conversión</TableHead>
                      <TableHead>Productos</TableHead>
                      <TableHead className="text-right">Ventas verificadas</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.ads.map((a) => (
                      <TableRow key={a.source_id}>
                        <TableCell>
                          <div className="font-medium">{a.headline ?? 'Sin título'}</div>
                          <div className="text-xs text-muted-foreground">ID {a.source_id}</div>
                        </TableCell>
                        <TableCell className="text-right">{a.contacts}</TableCell>
                        <TableCell className="text-right">{a.orders}</TableCell>
                        <TableCell className="text-right">{money(a.order_amount)}</TableCell>
                        <TableCell className="text-right">{a.units}</TableCell>
                        <TableCell className="text-right">{a.conversion_pct === null ? '—' : `${a.conversion_pct}%`}</TableCell>
                        <TableCell className="text-xs">{a.products.map((p) => `${p.name} ×${p.units}`).join(', ') || '—'}</TableCell>
                        <TableCell className="text-right text-muted-foreground">No disponible</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {report.product_sales && (
            <Card data-testid="sold-products">
              <CardHeader>
                <CardTitle className="text-base">Por producto vendido</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {report.product_sales.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sin pedidos confirmados en este periodo.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Producto</TableHead>
                        <TableHead className="text-right">Compradores</TableHead>
                        <TableHead className="text-right">Pedidos</TableHead>
                        <TableHead className="text-right">Unidades</TableHead>
                        <TableHead className="text-right">Ventas</TableHead>
                        <TableHead className="text-right">Ticket promedio</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.product_sales.map((p) => (
                        <TableRow key={p.product.toLowerCase()}>
                          <TableCell className="font-medium">{p.product}</TableCell>
                          <TableCell className="text-right">{p.buyers}</TableCell>
                          <TableCell className="text-right">{p.orders}</TableCell>
                          <TableCell className="text-right">{p.units}</TableCell>
                          <TableCell className="text-right">{money(p.sales)}</TableCell>
                          <TableCell className="text-right">{p.avg_ticket === null ? '—' : money(p.avg_ticket)}</TableCell>
                        </TableRow>
                      ))}
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

          <p className="text-xs text-muted-foreground">
            Los importes son pedidos confirmados, no ventas cobradas. {report.verified_sales.reason} ROAS no disponible: {report.roas.reason} Conversión = contactos del
            anuncio que pidieron ÷ contactos del anuncio en el periodo.
          </p>
        </>
      )}
    </div>
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
