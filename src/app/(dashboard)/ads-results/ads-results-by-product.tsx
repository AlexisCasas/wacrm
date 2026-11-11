'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { MetaAdInfo, ProductAdRow, ProductSalesRow } from '@/lib/meta-capi/report'

// "Por producto" view (formerly the always-visible "Rendimiento por producto" card). PRESENTATION ONLY: same columns, figures, ordering and the same Producto -> Anuncios drilldown
// as before; it just no longer competes with the per-ad view (the page title above says "Rendimiento por producto"). Local to /ads-results.

const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

export function AdsResultsByProduct({ productSales, hasDrilldown }: { productSales: ProductSalesRow[]; hasDrilldown: boolean }) {
  // Which product rows are expanded (by product name). Lives here: switching period unmounts the report and so resets it.
  const [openProducts, setOpenProducts] = useState<ReadonlySet<string>>(new Set())
  return (
    <Card data-testid="sold-products" className="overflow-hidden">
      <CardContent className="overflow-x-auto pt-4">
        {productSales.length === 0 ? (
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
              {productSales.map((p) => {
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
