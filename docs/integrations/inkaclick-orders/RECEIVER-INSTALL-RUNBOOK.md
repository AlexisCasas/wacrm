# Instalación del receptor en InkaClick (solo migración + Edge Function)

Estado (2026-10-31): **fases 0 a 3 EJECUTADAS** con autorización expresa en el proyecto productivo de InkaClick: respaldo verificado, migración aditiva (`20261101010000`, una transacción, versión registrada), función `wacrm-confirmed-orders` v1 con `verify_jwt=false`, secreto `WACRM_ORDERS_TOKEN` fijado por la persona responsable, pruebas de seguridad PASS y emisor de WACRM preparado y apagado. **No repetir la migración ni el despliegue.** Pendiente: la prueba controlada (`PHASE4-CONTROLLED-TEST.md`). Cada bloque `[AUTORIZAR]` requirió permiso expreso.

Principios: la migración es **aditiva** (dos columnas nulables, un índice parcial, una tabla, una función); el frontend productivo actual sigue funcionando sin cambios; los pedidos `held` de WACRM **nunca** se liberan solos (`held` solo pasa a `pending` por decisión manual expresa) y `enabled` en WACRM permanece `FALSE`.

## 0. Preflight (solo lectura)
- Confirmar el proyecto Supabase de InkaClick por su referencia (no el proyecto «Butsan»).
- Comprobar que **no** existen `external_order_id`, `departamento`, `wacrm_order_events`, `create_confirmed_order_from_wacrm` ni la función `wacrm-confirmed-orders`.
- Anotar: recuento de `confirmed_orders` por `source`, fecha del último pedido de ManyChat, funciones desplegadas, y los 5 disparadores de `confirmed_orders`.
- Fijar el commit exacto de `InkaClick-Saas` a instalar (archivos: migración `20261101010000_wacrm_confirmed_orders.sql` y `supabase/functions/wacrm-confirmed-orders`).
- Condición previa: E2E en un proyecto de pruebas real con las pruebas H1–H8 de `E2E-HTTP-QA.md` (es lo único que valida el gateway alojado).

## 1. Respaldo `[AUTORIZAR]`
Copia del esquema y de `confirmed_orders` (o punto de restauración del proyecto) antes de cambiar nada. Criterio: archivo no vacío y recuentos anotados.

## 2. Secreto `[AUTORIZAR]`
Generar un secreto aleatorio nuevo (≥ 32 bytes) y guardarlo como `WACRM_ORDERS_TOKEN` en los secretos de las Edge Functions del proyecto. El mismo valor se guardará después en WACRM como `INKACLICK_ORDERS_TOKEN` (fase de activación, no ahora). No imprimirlo ni commitearlo.

## 3. Migración `[AUTORIZAR]`
Aplicar solo `20261101010000_wacrm_confirmed_orders.sql`, en una transacción. Verificar: columnas y índice existen; la función y la tabla existen; `anon`/`authenticated` sin `EXECUTE`; RLS activa en `wacrm_order_events`; recuentos por `source` iguales a los del preflight; los 5 disparadores intactos.

## 4. Función `[AUTORIZAR]`
```bash
supabase functions deploy wacrm-confirmed-orders --no-verify-jwt --project-ref <REF_INKACLICK>
```
No desplegar ninguna otra función. Verificar que las demás funciones siguen con la misma versión.

## 5. Pruebas de humo (sin crear pedidos)
- POST sin token → 401; con token incorrecto → 401.
- GET con el secreto y un UUID inexistente → 404 (no escribe nada).
- Confirmar que otra función cualquiera sigue exigiendo JWT.
- Recuentos por `source` sin cambios.
No enviar un POST válido en esta fase: el primer pedido real controlado es la fase 5 del plan de activación y se autoriza aparte.

## 6. No hacer
No desplegar el frontend, no tocar ManyChat ni su receptor, no activar `enabled`, `INKACLICK_ORDERS_ENABLED` ni el cron en WACRM, no reenviar los pedidos `held`.

## Rollback
| Situación | Acción |
|---|---|
| Cualquier problema tras el paso 4 | `supabase functions delete wacrm-confirmed-orders --project-ref <REF_INKACLICK>` y retirar el secreto; la migración puede quedarse (aditiva) |
| Retirar también el esquema (solo si `wacrm_order_events` y las filas `source='wacrm'` están vacías) | `DROP FUNCTION create_confirmed_order_from_wacrm(jsonb); DROP TABLE wacrm_order_events; DROP INDEX confirmed_orders_source_external_order_uidx; ALTER TABLE confirmed_orders DROP COLUMN external_order_id, DROP COLUMN departamento;` |
| Fallo de la migración | La transacción se deshace sola; no continuar |
| Frontend | No se despliega en este runbook; nada que revertir |

## Después (autorización aparte)
Frontend: PR `AlexisCasas/InkaClick-Saas#5` (departamento y descripción segura, base `feature/whatsapp-inbox-crm`). Fusionarlo en esa rama genera un despliegue de **Producción** en Vercel.
