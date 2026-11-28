# WACRM — Filtros de Cobranza

**Fecha:** 2026-11-28  
**Base productiva:** `6a1ba63366e1c88156441c96db74c6144594e77c`  
**Candidato:** `d20f5858345a9b4d60d7f4a44dabf0f26a7002b2`

## Objetivo

Permitir que Logística/Supervisión filtren **Pedidos confirmados** por estado financiero real, sin recalcular importes en el navegador.

## Fuente de verdad

Se reutiliza el backend financiero existente:

- `order_financials.financial_status`
- estados incluidos: `unpaid` y `partially_paid`
- endpoint existente: `GET /api/orders/payments/with-balance`

El navegador no calcula Total, Pagado ni Saldo.

## UX

En **Pedidos confirmados** aparece un filtro:

**Con saldo (N)**

Al activarlo:
- muestra únicamente pedidos cuyo id está en la respuesta del backend financiero;
- conserva búsqueda, estado de integración y demás filtros;
- sigue cargando páginas por keyset cuando un pedido con saldo está en una página posterior;
- "Limpiar filtros" lo desactiva;
- si el usuario no tiene acceso al backend de pagos, el filtro no se muestra.

## Actualización

El listado de ids con saldo se vuelve a consultar cuando se emite:

`wacrm:payments-changed`

Así un pago confirmado que deja el saldo en cero puede sacar el pedido del filtro sin recargar toda la aplicación.

## Seguridad

- cuenta y permisos siguen resueltos del lado servidor;
- RLS permanece intacto;
- no se pasan account ids desde el navegador;
- no se modifica ningún pago ni pedido;
- no hay migrations.

## Archivos modificados

- `src/components/orders/confirmed-orders-workspace.tsx`
- `src/components/orders/confirmed-orders-workspace.test.tsx`

## Validaciones requeridas antes de deploy

1. Tests de ConfirmedOrders.
2. Tests de payments / with-balance.
3. Typecheck.
4. Lint.
5. Build.
6. Candidate aislado y dry-run.
7. QA funcional:
   - pedido unpaid aparece;
   - pedido partially_paid aparece;
   - pedido paid no aparece;
   - limpiar filtro restaura lista;
   - combinación con búsqueda/status no rompe paginación;
   - cambio de pago refresca el filtro.

## Fuera de alcance

- filtros separados "Pago parcial" / "Pagado";
- vencimiento por fecha;
- filtros por monto;
- cambios de DB;
- cambios en unread/read;
- búsqueda de contactos por celular.


## Alcance final acordado

El filtro de Cobranza se implementa server-side en `GET /api/orders/confirmed` con estas opciones:

- Todos
- Con saldo = unpaid + partially_paid
- Sin pagar = unpaid
- Pago parcial = partially_paid
- Pagado = paid

El filtro se aplica antes de la paginación keyset, por lo que opera sobre todo el conjunto de pedidos y no solo sobre la página cargada. No se crean migrations ni se cambia la lógica de pagos.
