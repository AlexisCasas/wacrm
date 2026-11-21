# Dry-run de base de datos: release PR-01→PR-06 sobre una copia aislada del backup productivo (2026-11-20)

Candidato: `release/pr01-pr06-prod-integration` @ `0eddc0f733ba9656fc4b355e93db56e01e21472a` (árbol `4cd8ef0929245ffacf849e981957a03d15e0d2a6`). Producción: **solo lectura + un backup**; no se migró, desplegó, reinició ni se cambió nada de env, flags o crons. InkaClick no se tocó.

## 1. Backup productivo (único cambio en el servidor: un directorio nuevo)

`/opt/backups/wacrm/pr01-pr06-dryrun-predeploy-20261120T042242Z/` (modo 700; archivos 600):
`db/wacrm_full_20261120T042242Z.dump` (pg_dump 17.6, formato custom, un solo snapshot consistente, **234 102 182 bytes**), `globals_….sql`, `schema_only_….sql`, `SHA256SUMS`, `state/BACKUP-METADATA.txt` (origen, versiones, SHA del release candidato).
SHA256 del dump: `2a0c8bd97fbbb276e53e4bd9fda1e67a7db1de9a382f60093593b33307f37056` (estable: recalculado dos veces; `sha256sum -c` OK en servidor y en la copia local). `pg_restore --list`: 2076 entradas, 133 de datos, con las 13 tablas críticas verificadas. Sin errores en `pg_dump` / `pg_dumpall`. No se borró ningún backup anterior.

## 2. Aislamiento

Red Docker `dryrun-int` (`--internal`: sin ruta de salida; verificado: `graph.facebook.com` desde la app = timeout), sin puertos publicados. Contenedores: `dryrun-db` (misma imagen que producción `supabase/postgres:17.6.1.136`), `dryrun-auth` (`gotrue v2.189.0`), `dryrun-rest` (`postgrest v14.12`), `dryrun-gateway` (Caddy), `dryrun-app` (candidato). Secretos aislados generados para la ocasión (no productivos). Sin Meta, Shalom, OCR fake, meta-sim, crons ni InkaClick. Restauración completa (esquemas, datos, funciones, triggers, RLS, enums, constraints, extensiones): `pg_restore` con **0 errores** (se crearon antes los 2 roles de plataforma que el dump referencia y la imagen no trae).

## 3. Baseline y fidelidad

`scripts/release/db-baseline.sql`: estructura (nombres + md5 de definiciones), conteos de las 86 tablas de `public` y md5 de los datos de 19 tablas críticas (sin contenido). **Producción vs clon PRE**: 1649 líneas de estructura, 6 de diferencia = 2 CHECK con distinta anidación de paréntesis tras dump/restore (semánticamente iguales) y la función de plataforma `auth.jwt()`. Datos: 1011 pedidos, 9 cuentas, 12 perfiles, 25 110 contactos, 25 102 conversaciones, 467 017 mensajes.

## 4. Las 22 migraciones (una por una, orden del manifest, `psql -1 -v ON_ERROR_STOP=1`, lock_timeout 3 s, statement_timeout 30 s)

Prechecks: bloque contiguo, checksums, ninguna versión pre-existente, prerrequisitos productivos presentes (`logistics_mvp_enabled`, `name_locked`, `contact_deletion_*`, `inbound_dispatch_ledger`), ningún objeto del release pre-existente. Resultado: **22/22 `rc=0`, 201–361 ms cada una**, objetos declarados verificados tras cada una y un `.applied` por migración generado en un directorio LOCAL (formato de producción + versión original). Ningún fallo, ninguna espera por locks.

## 5. PRE vs POST (clon)

| Categoría | Sin cambio | Cambiado | Eliminado | Añadido |
|---|---|---|---|---|
| tablas | 116 | 1 (`notifications`: +`order_id`, `conversation_id` nullable) | 0 | **19** |
| constraints | 564 | 1 (`notifications_type_check`, ampliado) | 0 | 172 |
| índices | 354 | 0 | 0 | 72 |
| funciones | 297 | 2 (`create_order_confirmation` +routing, `set_member_operational_role` +delegación) | 0 | 91 |
| triggers | 56 | 0 | 0 | 23 |
| políticas | 143 | 7 (`conversations`/`messages`/`message_reactions`: ahora vía `conversation_operational_access`, legacy con flag OFF) | 0 | 18 |
| RLS | 94 | 0 | 0 | 19 (todas las nuevas con RLS) |
| enums, extensiones | 2 / 7 | 0 | 0 | 0 |
| buckets | 4 | 0 | 0 | 1 (`order-docs`) |
| conteos de 86 tablas | **86 idénticos** | 0 | | 19 tablas nuevas con 0 filas |
| hash de datos (18 de 19 tablas) | **18 idénticos** | `notifications`: el hash cambia solo por la columna nueva (con ella proyectada fuera el hash es **idéntico** `f94271f9…`; 0 filas con `order_id`) | | |

Cero pérdida, cero duplicación, nada eliminado; cambios solo aditivos más los 3 cambios esperados de constraint / funciones / políticas.

## 6. Flags, pedidos históricos y storage (post)

`logistics_mvp_enabled` conservado (false); no existen filas de `order_shipment_settings` / `order_payment_settings`; defaults `shalom_tracking_enabled = false`, `destination_customer_message_enabled = false`, `order_payments_enabled = false`. **Los 1011 pedidos históricos: 0 filas en `order_financials` (not_tracked), 0 pagos, 0 finalizaciones.** `order-docs`: privado (`public = false`), 10 MB, PDF/JPEG/PNG/WebP, **sin ninguna política en `storage.objects`**; los otros 4 buckets sin cambios. Triggers nuevos sobre tablas existentes: `order_confirmations_financials_seed`, `order_shipments_no_manual_delivery`, `order_shipments_pickup`. Los 18 RPC de escritura: ejecutables solo por `service_role` (anon / authenticated: no); `derive_conversation_to_commercial` solo `authenticated`, por diseño. Navegador: solo `SELECT` en las 19 tablas nuevas.

## 6b. Candidato

Imagen `wacrm-app:dryrun-0eddc0f7` = `sha256:8037d0c37491df21310aa244d40ccf0b992cedf49c62180a054d08a2896b2a4d` (labels `revision = 0eddc0f7…`, `source-tree = 4cd8ef09…`), construida con `git archive` del commit (sin `.env*`), `NODE_ENV=production`, solo variables aisladas. **No sustituye ninguna imagen productiva.**

## 7. Smoke contra el clon (flags OFF) — 25/25 PASS

Login (GoTrue del clon), `/login`, `/inbox`, `/contacts`, `/confirmed-orders`, `/settings`; redirección sin sesión; RLS con nuevas políticas y flag OFF: **19 765 conversaciones, 326 907 mensajes y 1011 pedidos visibles = exactamente los de la cuenta**; `contacts.name_locked`; historial de pedidos; **Contact Deletion Controls** (preview con límites e impacto, sin borrar); Pedidos Confirmados `403 feature_disabled`; rutas logistics / shalom / payments / abandoned / panel / chat-summary / derive rechazadas; routing `enabled:false`; cron de routing 401 sin secreto y sin trabajo con él; **cron Shalom: kill switch OFF, proveedor `not_configured`, 0 consultas**; cron de InkaClick: `enabled:false`. Name lock, búsqueda, clear custom fields y manual flow start: cubiertos por la suite de tests del candidato (mismos blobs que producción).

## 8. Activación aislada (solo en el clon)

`logistics_mvp_enabled = true` en la cuenta de prueba + `backfill_conversation_routing`: **991 filas** `conversation_routing` (= conversaciones distintas con pedido), eventos `backfill` 991, **segunda ejecución = 0**, ninguna otra cuenta tocada. Con áreas asignadas (supervisor / comercial / logística / sin área): supervisor ve las 19 765; comercial 18 774 (las sin pedido); logística 991; **sin área: 0**. Pedidos Confirmados: supervisor y logística 200; comercial y sin área 403. Routing API: logística ve `stage: logistics, can_derive`; comercial no ve ese chat.
`order_payments_enabled = true` en el clon: **los pedidos históricos siguen sin fila financiera** (panel `tracked:false`, sin resumen, fuera de "Con saldo"); un pedido NUEVO nace `unpaid` (S/100), se registra y confirma S/100 por la API → `paid`, saldo 0; comercial no abre el panel (403). Shalom y mensaje del día 15 permanecieron apagados.

**Prerrequisito operativo descubierto (no es un bug, es el diseño de PR-02):** con `logistics_mvp_enabled = true`, un miembro **sin área operativa no ve ninguna conversación** (incluido un owner/admin sin área). Antes de activar el flag en producción hay que asignar el área operativa a cada miembro (y correr el backfill de la cuenta).
