# Cierre del QA comercial y plan de activación de InkaClick

Estado al 2026-10-31. La captura comercial de WACRM está **desplegada y en piloto**; la entrega a InkaClick sigue **apagada**: `confirm_enabled = TRUE` solo en la cuenta piloto, `enabled = FALSE`, sin cron, `INKACLICK_ORDERS_ENABLED` sin definir. Este repositorio es público: no hay nombres, correos ni identificadores de cuentas.

## 1. QA comercial (producción, cuenta piloto)

| Caso | Evidencia | Resultado |
|---|---|---|
| El propietario confirma, el agente es vendedor | Pedido 1, `held`, 0 intentos, atribución correcta | PASS |
| El agente confirma, el propietario es vendedor | Pedido 2, `held`, 0 intentos, `confirmed_by` != `seller_user_id`, contacto distinto | PASS (solo lectura) |
| Sin entrega ni tráfico a InkaClick | 0 filas en `order_confirmation_deliveries`, sin ID externo, logs sin menciones | PASS |
| Aislamiento | 1 cuenta, 2 contactos, 0 pedidos en otras cuentas | PASS |
| Botón disponible tras registrar | Confirmado visualmente | PASS |
| Doble clic / reintento | Índice único `(account_id, request_key)` + `ON CONFLICT DO NOTHING`; `route.test.ts`; e2e caso 2; el diálogo bloquea el botón | PASS (automática; sin pedido extra) |
| Segundo pedido del mismo cliente | e2e caso 7 | PASS (automática) |
| Interruptores | e2e casos 9, 10, 13 | PASS (automática) |

Los dos pedidos `held` son de prueba y no se reenvían solos.

## 2. Receptor existente (InkaClick-Saas, rama `main`)

El receptor de WACRM **ya existe**; no se crea otro. Archivos: `supabase/functions/wacrm-confirmed-orders/index.ts` (+ `index.test.mjs`), `supabase/migrations/20261101010000_wacrm_confirmed_orders.sql`, `supabase/tests/*`, `supabase/config.toml`.

| Pieza | Qué hace |
|---|---|
| Edge function | `POST` crea (201; 200 en repetición), `GET ?external_order_id=` reconcilia (200/404). Errores con `code` corto, sin datos del cliente |
| Autenticación | Secreto propio `WACRM_ORDERS_TOKEN` (Bearer, comparación en tiempo constante). Sin secreto configurado → 503; sin token o incorrecto → 401 |
| `verify_jwt` | `false` solo para esta función (`config.toml` y `--no-verify-jwt`); el handler exige el secreto siempre |
| Migración (aditiva) | `confirmed_orders.external_order_id UUID` y `departamento TEXT` (nulables), índice único parcial `(source, external_order_id)`, tabla `wacrm_order_events` (sin datos personales, RLS, solo `service_role`), función `create_confirmed_order_from_wacrm(jsonb)` (solo `service_role`) |
| Validación | `source='wacrm'`, UUID, precio `^[0-9]{1,7}(\.[0-9]{1,2})?$` y > 0, cantidad ≥ 1, teléfono `^51[0-9]{9}$`, fecha `-05:00`, `estado_pedido='Pedido confirmado'`, obligatorios: nombre, producto, destino, vendedor |
| Almacenamiento | descripción → `descripcion_pedido_url` (texto libre, no URL); departamento → `departamento`; `raw_payload` sin datos personales |

**Producción de InkaClick (verificado en solo lectura):** no tiene la migración ni la función; tiene los 5 disparadores esperados y solo filas `manychat`.

## 3. QA aislado realizado (sin tocar producción)

Base PostgreSQL 16 desechable, sin red y sin puertos, con la réplica de esquema del repositorio; el contenedor se eliminó al terminar.

| Verificación | Resultado |
|---|---|
| Aserciones SQL del repositorio (idempotencia, validaciones, disparadores de clientes y pagos, convivencia con filas ManyChat) | PASS (`all assertions passed`) |
| Pruebas del handler (autenticación, mapeo de estados, sin datos en errores) | PASS, 7/7 |
| Contrato: payload generado con el código real del emisor de WACRM, enviado dos veces | PASS: 1 fila, segunda llamada `created=false`, `wacrm_order_events` = `created`, `replayed`; 1 cliente |
| Los dos pedidos `held` reales frente a los validadores del receptor | PASS (teléfono `51`+9 dígitos, precio válido) |
| Fidelidad de la réplica | Los 5 disparadores de la réplica coinciden con los de producción |

**No cubierto aún:** ejecutar la función desplegada en un proyecto Supabase real (gateway, secreto, `verify_jwt=false`), concurrencia real y la reconciliación `GET` contra datos reales. Requiere un proyecto de pruebas (una rama de base de datos tiene coste y necesita autorización).

## 4. Matriz de compatibilidad con ManyChat

| Aspecto | ManyChat | WACRM | Conflicto |
|---|---|---|---|
| `source` | `manychat` | `wacrm` | No |
| Clave de idempotencia | `duplicate_key` (índice no único) | `external_order_id` (único parcial, solo filas con valor) | No: las filas ManyChat quedan fuera del índice |
| Receptor | Vercel (código fuera del repositorio) | Edge function propia | No se toca el de ManyChat |
| Secreto | el suyo | `WACRM_ORDERS_TOKEN` | Independientes |
| Auditoría | `manychat_webhook_events` | `wacrm_order_events` | Tablas separadas |
| Columnas nuevas | no las usa | `external_order_id`, `departamento` (nulables) | Lectores con `select *` no se rompen |
| Disparadores (pagos, teléfono, clientes) | actúan | actúan igual | Validación previa evita `precio` 0 y teléfonos no normalizables |
| `estado_pedido` | `procesado` en su mayoría | `Pedido confirmado` | Sin conflicto; el operador lo cambia desde la UI |

## 5. Interfaz logística (rama funcional `feature/whatsapp-inbox-crm`)

La rama funcional **no contiene** el receptor (vive solo en `main`) y `main` no contiene la rama funcional: no se reemplaza una por otra. La API lista con `select *` y sin filtro por `source`, así que las filas `wacrm` aparecen.

| Campo | ¿Se muestra? |
|---|---|
| Producto, cantidad, precio, vendedor, agencia, destino, estado, fecha | Sí (lista y detalle) |
| Departamento | **No** (ni en el tipo ni en pantalla) |
| Descripción del pedido | Se muestra como **enlace** (`href`). Un texto libre no es una URL: enlace roto y, con valores `javascript:`, un riesgo de seguridad |

Propuesta (rama local `codex/wacrm-orders-ui`, un commit sobre la rama funcional, **no publicada ni desplegada**): tipo con `departamento`/`external_order_id`, campo «Departamento» en el detalle y descripción como texto plano salvo que empiece por `http(s)://`. Compila con `vite build`; el `tsc` global ya tiene errores previos ajenos al cambio.

## 6. Plan de activación gradual

Cada fase es una autorización aparte. Un fallo detiene el avance.

| Fase | Acción | Verificación | Reversión |
|---|---|---|---|
| 0 | Panel de Vercel de InkaClick: rama de producción y alias | Confirmación humana | n/a |
| 1 | Proyecto Supabase de pruebas (no el productivo): réplica de esquema + migración + función con `--no-verify-jwt` y secreto de pruebas | 401 sin token; 201 y luego 200 con el mismo ID; `GET` 200/404; 422 con datos inválidos; ManyChat intacto | Borrar el proyecto de pruebas |
| 2 | WACRM contra pruebas: URL/token de pruebas, `INKACLICK_ORDERS_ENABLED=true`, `enabled=TRUE` solo en la cuenta piloto, cron llamado a mano | Un pedido nuevo pasa `pending` → `sent` → `acknowledged`; los `held` no se envían | `enabled=FALSE` |
| 3 | Fallos: receptor caído, 4xx, respuesta perdida | Backoff, `failed` visible, sin duplicados | `enabled=FALSE` |
| 4 | Despliegue del receptor en InkaClick productivo: respaldo, migración aditiva, función, secreto | Funciones previas intactas; `confirmed_orders` sin cambios de datos | Dejar de llamar a la función; las columnas pueden quedarse |
| 5 | Un pedido real controlado; frontend con la propuesta de §5 (despliegue independiente) | Una fila `source=wacrm`; departamento y descripción visibles | `enabled=FALSE`; borrar la fila de prueba solo con autorización |
| 6 | Cron y resto de cuentas, de una en una | Métricas de `failed`/`pending` | Interruptor por cuenta |

**Despliegue independiente del frontend:** el receptor (base de datos + función) y el frontend se despliegan por separado; el frontend productivo actual sigue funcionando sin la migración y la migración no cambia lo que lee. El frontend de §5 se publica después, desde la rama funcional, nunca desde `main`.

## 7. Rollback

| Qué | Cómo |
|---|---|
| Envío desde WACRM | `enabled=FALSE` por cuenta (inmediato) o quitar `INKACLICK_ORDERS_ENABLED` |
| Captura comercial | `confirm_enabled=FALSE` por cuenta; el historial permanece |
| Receptor en InkaClick | No llamarlo (quitar la URL o el secreto); columnas, índice y tabla de eventos son aditivos y pueden quedarse |
| Frontend | Redesplegar el despliegue anterior de Vercel |

## 8. Riesgos y pendientes

- Receptor no probado en un proyecto Supabase real; la migración se aplica por quien administra ese proyecto.
- Vercel de InkaClick: fusiones a `main` crean despliegues de Producción y el alias sirve una rama de funcionalidad; verificar en el panel.
- Frontend: descripción como enlace y falta de departamento (propuesta en §5).
- El estado `Pedido confirmado` y la pantalla del operador: confirmar con el equipo que no se procesa automáticamente.
- Correo: SPF sin Brevo e IP autorizada sin confirmar (ajeno a pedidos).
- Error previo ajeno: `messages_status_check` (estados de audio).
- Otros documentos del repositorio, ajenos a pedidos, mencionan nombres de cuentas; no se tocan aquí.

## 9. Recomendación

- **GO** para preparar el proyecto de pruebas y ejecutar las fases 1 a 3 (sin producción).
- **NO-GO** hoy para el despliegue productivo del receptor (fase 4) y para activar `enabled`, el cron o el webhook: faltan la validación en un proyecto real y la decisión sobre el frontend.
