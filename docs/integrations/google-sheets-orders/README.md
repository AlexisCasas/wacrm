# Exportación de pedidos a Google Sheets (WhatsCRM → Sheets, unidireccional)

Estado: **borrador de desarrollo con QA**. Nada desplegado, ninguna migración aplicada en producción, ningún pedido real escrito en una hoja.

## 1. Arquitectura
- **Fuente única de verdad**: `order_confirmations` + `order_confirmation_items`. La hoja es una proyección reproducible; nunca se lee de ella para el negocio.
- **Descubrimiento por pull**: `order_sheet_enqueue()` crea un trabajo por cada pedido `delivery_status='acknowledged'` (y `confirmed_at >= eligible_since`) que no tenga uno. No hay trigger sobre pedidos: el camino de confirmación/InkaClick no cambia.
- **Cola durable** `order_sheet_exports` (1 fila por pedido): `pending → processing → exported | dead | excluded`. Reintentos con el backoff existente (30 s … 1 h, ±20 %), `dead` tras 8 intentos; `order_sheet_requeue()` los devuelve a la cola.
- **Un solo escritor por hoja**: lease con *token de fencing* en `order_sheet_destinations` (240 s). Solo el titular reclama trabajos y solo él puede marcarlos como exportados.
- **Reconciliar antes de escribir (siempre)**: el worker lee la columna `Clave de fila`, añade solo las líneas que faltan (`values.append`, `RAW`, `INSERT_ROWS`), vuelve a leer y verifica una vez cada clave antes de marcar el trabajo. Un fallo ambiguo (Google aplicó la escritura y la respuesta se perdió) se resuelve solo en la siguiente pasada sin duplicar.
- **Aislamiento**: un fallo de Sheets nunca toca el pedido ni su entrega a InkaClick (prueba: el hash de la fila del pedido no cambia con Sheets caído). Cron propio, interruptor global `ORDERS_SHEETS_EXPORT_ENABLED` e interruptor por cuenta (`order_sheet_destinations.enabled`, por defecto `false`).
- **Cuentas**: tablas y funciones por `account_id`; cada cuenta tiene su propia hoja. Se activa solo Keyler.
- **Cliente Google**: cuenta de servicio, JWT RS256 con `node:crypto` y `fetch` (sin dependencias nuevas). La clave solo existe en el entorno del servidor; los errores llevan códigos, nunca la clave ni datos de clientes.
- Código: `src/lib/orders/sheets/{layout,google-client,exporter,reconcile}.ts`, ruta `src/app/api/orders/sheets-export/cron/route.ts` (`?mode=sync|reconcile`), script de host **sin instalar** `scripts/ops/orders-sheets/wacrm-orders-sheets-cron.sh`.

## 2. Esquema de exportación (pestaña «Registro de pedidos»)
Una fila por producto confirmado; los datos generales se repiten en cada fila. A–N son las 14 columnas comerciales originales; O+ son técnicas.

| Col | Encabezado | Contenido |
|---|---|---|
| A–N | Fecha … Departamento | como antes. **Precio (H) = subtotal de la línea** (pedido tradicional: total del pedido). Fecha/hora en hora de Lima, como número de serie |
| O | ID pedido | UUID |
| P | Línea | 1…20 |
| Q | Clave de fila | `ID pedido:línea` (**clave única**) |
| R, S | Líneas del pedido, Unidades del pedido | |
| T | Importe del pedido (no sumar) | total del pedido, repetido |
| U | Precio unitario | vacío en pedidos tradicionales (no se inventa) |
| V | Tipo | `multiproducto` / `tradicional` |
| W, X | Cuenta, ID catálogo | |
| Y, Z, AA | Hash de fila, Exportado (UTC), Versión de esquema | |

Reglas: la suma de subtotales debe igualar el total del pedido y `cantidad × precio unitario = subtotal`; si no, el pedido pasa a `dead` con código (`total_mismatch`, …) y **no se exporta**. El worker comprueba los encabezados A–AA antes de escribir (`layout_mismatch`). Texto con `=`, `+`, `@` queda como texto (`RAW`).

Pestañas: «Ventas x producto» y «Ventas x vendedor» son fórmulas sobre las líneas (cada pedido cuenta una vez, por su línea 1; nunca se suma el importe del pedido). «Control de conciliación» compara hoja vs. base de datos y lista aparte excluidos y no confirmados. Las columnas de comisión del libro de ManyChat **no se migran** (decisión pendiente del negocio).

## 3. Configuración de Google (valores a rellenar por el titular; nada inventado)
1. Proyecto de Google Cloud → habilitar **Google Sheets API**.
2. Crear una cuenta de servicio (sin roles de proyecto) y una clave JSON.
3. Crear la hoja definitiva **limpia** (copiar la hoja QA, no la copia con datos de ManyChat) y compartirla **solo** con el correo de la cuenta de servicio como **Editor**. No se comparte nada más.
4. En el servidor (`.env.local`, nunca en Git/frontend/logs): `ORDERS_SHEETS_EXPORT_ENABLED=true`, `GOOGLE_SHEETS_SA_EMAIL=<correo>`, `GOOGLE_SHEETS_SA_KEY_B64=<base64 del private_key PEM>`. Añadir variables exige recrear `app` (≈10 s de 502; hacerlo junto a un cambio de imagen en la ventana tranquila).
5. Registrar el destino: `insert into order_sheet_destinations (account_id, spreadsheet_id, enabled, eligible_since) values ('<keyler>','<id hoja>',false,null)`.

Hoy: **no existen credenciales** en el entorno, por lo que el cliente se probó contra un servidor HTTP falso (firma RS256 verificada con la clave pública, refresco 401, clasificación 429/5xx/403/404/400, timeouts) y la hoja QA se rellenó con filas sintéticas generadas por la misma proyección.

## 4. QA realizado (sintético, aislado; sin tocar producción)
- Unitarias: proyección (ejemplo Hidrolavadora 95 + Discos 50 → 2 filas, 1 pedido, 2 unidades, S/ 145), pedido tradicional, datos inconsistentes, serie de fecha Lima, cliente HTTP, ruta cron (503/401/400 y interruptor global).
- Integración sobre BD aislada (`scripts/qa/orders-sheets/setup.sh`, `QA_E2E=1`): solo `acknowledged`; exclusiones; re-ejecución sin cambios (hash de trabajos y hoja idénticos); escritura ambigua; fallo previo; Sheets caído → backoff → `dead` a los 8 intentos → `requeue`; recuperación tras caída de worker (lease/lock vencidos, el worker caído ya no puede completar); 3 workers concurrentes sin duplicados; separación entre cuentas; hoja alterada; `eligible_since`; privilegios (`anon`/`authenticated` sin acceso).
- Hoja QA sintética (4 pestañas): <https://docs.google.com/spreadsheets/d/1zjwubBlj01eKfsdcn3-FM8a5Vw4a7qPSxPKsCaRdLfk/edit>. Las vistas dan 4 pedidos, 6 líneas, 10 unidades, S/ 625 y «Sin diferencias».
- **Ensayo de carga histórica** (copia de un respaldo de producción de 2026-11-06 15:34Z restaurada en un contenedor local aislado; hoja simulada en memoria; solo agregados): 226 pedidos `acknowledged` → 226 pedidos / 227 líneas / 260 unidades / S/ 31 366,00 en la hoja; 0 claves faltantes, sobrantes, duplicadas o con importe distinto; 2 pedidos no confirmados (`held`) quedan fuera; segunda pasada: 0 filas nuevas, hoja idéntica. 2 pedidos `acknowledged` coinciden con heurísticas de «prueba/demo»: **un humano debe decidir** si se excluyen (`order_sheet_exclusions`) antes de la carga.

## 5. Procedimiento de carga histórica (tras autorización)
1. Aplicar la migración `20261109000000_order_sheet_exports.sql` como `postgres` (solo añade 4 tablas y 8 funciones; inerte con `enabled=false`).
2. Decidir exclusiones (pedidos de prueba) con el titular e insertarlas en `order_sheet_exclusions`.
3. Hoja definitiva limpia compartida con la cuenta de servicio; variables en el servidor; destino con `enabled=false`.
4. Activar el destino (`enabled=true`, `eligible_since=null`) y ejecutar `wacrm-orders-sheets-cron.sh sync` repetidamente hasta `claimed=0`; luego `... reconcile`: **debe dar `differences=0`**.
5. Segunda ejecución de `sync`: 0 filas añadidas. Solo entonces instalar el cron de 2 min (`/etc/cron.d/wacrm-orders-sheets`).

## 6. Rollback
`update order_sheet_destinations set enabled=false` (para el export al instante) o quitar `ORDERS_SHEETS_EXPORT_ENABLED`; borrar `/etc/cron.d/wacrm-orders-sheets`. La hoja es una proyección: se puede vaciar y reconstruir desde la BD. La migración se revierte con `DROP` de las 4 tablas y 8 funciones (solo añadió objetos). Los pedidos y su entrega a InkaClick no se tocan en ningún caso.

## 7. GO / NO-GO para producción
**NO-GO hasta**: (a) credenciales y hoja definitiva reales; (b) una prueba contra la API real de Google con la cuenta de servicio sobre una hoja QA (no posible hoy); (c) decisión sobre los 2 pedidos candidatos a prueba y sobre las columnas de comisión; (d) autorización explícita para migración, variables/recreación de `app` y cron. El PR #81 y su migración no se tocan; el despliegue de imagen de PR-A sigue pendiente por separado.
