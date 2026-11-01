# InkaClick-Saas#6 revisión 2 — auditoría final y procedimiento de aplicación

Estado: **sin aplicar, sin fusionar** (borrador). Repositorio público: sin identificadores de clientes ni cifras absolutas de negocio. Pruebas reproducibles con `supabase/tests/run_customer_sync_tests.sh` (base desechable sin red; imagen `postgres:16-alpine`).

## 1. Matriz de auditoría
| # | Punto | Resultado | Evidencia |
|---|---|---|---|
| 1a | Clientes mixtos conservan el histórico | PASS | W1, W4, W6, W9, A2: 2→3; 5→6→7; nunca por debajo de las filas reales |
| 1b | Clientes **solo ManyChat**: comportamiento idéntico al anterior | PASS | misma instantánea de `customers` con la función vieja y la nueva (7 escenarios); A1 lo fija |
| 1c | La erosión de histórico de clientes solo-ManyChat (preexistente) | **RIESGO ABIERTO, no es regresión** | A1: contador guardado 5 sin pedidos + pedido nuevo → 1, igual que hoy. Opción aparte (aplicar la misma regla a ManyChat) |
| 2 | Un pedido WACRM no sobrescribe nombres existentes (alta, UPDATE, cliente con y sin DNI) | PASS | W1, W5, W7 |
| 3a | `is_test` en creación: ausente/null = real; booleano aceptado; otro valor → `22023 invalid_is_test` sin crear fila | PASS | W11 |
| 3b | Pedido de prueba: no crea ni modifica clientes, no cuenta, no cambia nombre/fecha | PASS | W8, A5 |
| 3c | Reenvío (replay): conserva la clasificación guardada, ignora un `is_test` distinto, no toca al cliente, 1 evento `replayed` | PASS | W3, A4 |
| 3d | Actualización: cambiar `is_test` de una fila no dispara el trigger (el cliente no cambia) | PASS | A3 |
| 3e | Informes: hoy **ningún consumidor filtra `is_test`** (listado/KPIs de pedidos, contexto de chat, resolución de producto de los cron, contador de clientes) | **PENDIENTE (frontend/funciones)** | §3 |
| 4 | Pedido E2E existente (creado antes de `is_test`, queda `FALSE`) | PASS | A3: un pedido real posterior da 3 (no se cuenta dos veces); marcarlo después no toca al cliente ni su auditoría; ver §4 |
| 5a | Migración ↔ función receptora: la función reemplazada es idéntica salvo `is_test`; contrato del receptor intacto | PASS | test `10_*` tras migrar |
| 5b | Emisor actual (sin `is_test`) sigue funcionando | PASS | todos los escenarios WACRM omiten el campo |
| 5c | Orden con el futuro emisor | **Restricción** | §5: SQL primero; nunca enviar pedidos de prueba antes de aplicar y verificar el SQL |
| 6a | Permisos: `anon`/`authenticated` sin `EXECUTE` sobre el receptor; `service_role` sí; ACL de `confirmed_orders` sin cambios; sync sigue `SECURITY DEFINER` con `search_path` fijo | PASS | A6 |
| 6b | Idempotencia de la migración (aplicarla dos veces) | PASS | paso 6 del runner |
| 6c | Bloqueo: con la tabla ocupada el `ALTER` falla rápido por `lock_timeout` y reintenta con éxito | PASS | paso 7 |
| 6d | Rollback restaura **ambas** funciones a su definición exacta anterior (hash) y los permisos | PASS | paso 8 |
| 6e | Las pruebas detectan regresiones | PASS | mutante 1 (recuento sin histórico) falla en W1; mutante 2 (pruebas tocan clientes) falla en W8 |
| 6f | La base desechable representa a producción | PASS | hashes de ambas funciones antes de migrar = los de producción (sync `ea53d7a9…`, receptor `3cf7658a…`) |
| 7 | Fusionar a `main` genera un despliegue de Vercel | **RIESGO, sin mitigación por commit** | §6: `[skip ci]` **no** lo evita (probado) |

## 2. Semántica de `is_test` (especificación)
- Opcional en el payload del receptor; solo booleanos JSON; `null`/ausente = pedido real; el resto → 422 (`invalid_payload` en la función actual).
- Pedido de prueba = fila almacenada y auditada normalmente, pero **inerte para `customers`** y excluida de los recuentos del disparador.
- Se fija al crear; **un reenvío no lo cambia**. Cambiarlo a mano con `UPDATE` no recalcula contadores ni dispara el trigger de clientes (a propósito: un `UPDATE` de bandera no debe mover contadores).

## 3. Consumidores que deben filtrar `is_test` (cambios aparte, no incluidos en #6)
| Consumidor | Efecto hoy con un pedido de prueba |
|---|---|
| Listado y KPIs de «Pedidos confirmados» | cuenta como un pedido más |
| Contexto del chat y etapa de pipeline (vista y rutas de contexto) | aparece como pedido activo del contacto |
| `notify-destination-vouchers` / `sync-shalom-statuses` | pueden usar un pedido de prueba (producto «PRUEBA…») para resolver el producto de un voucher de ese teléfono |
| `send-confirmed-order-whatsapp` (manual) | un operador puede enviar el mensaje de embalaje de un pedido de prueba |
| Contador y KPI de clientes | no afectados por `is_test` (los pedidos de prueba no tocan clientes) |
Hasta que existan esos filtros, los pedidos de prueba deben usar solo contactos **sin vouchers** y avisar a logística.

## 4. Pedido E2E existente
Se creó antes de `is_test`: queda `FALSE` (comercial). Efectos: (a) el cliente de la prueba cuenta como «mixto» mientras siga sin marcar (regla de histórico: sin consecuencias, A3); (b) listados e informes lo cuentan como pedido real. Recomendación: **marcarlo** con un `UPDATE` explícito y autorizado, solo después de aplicar #6:
`UPDATE confirmed_orders SET is_test = TRUE WHERE source='wacrm' AND external_order_id = '<ID_E2E>';`
No dispara el trigger de clientes ni toca `wacrm_order_events`; sí cambia `confirmed_orders.updated_at` de esa fila (disparador de `updated_at`). Si se prefiere no tocar la fila, queda como pedido comercial y debe excluirse a mano en cualquier informe.

## 5. Compatibilidad con el futuro emisor de WACRM
- Hoy el emisor no envía `is_test`; el receptor lo trata como real (probado).
- **Orden obligatorio:** (1) aplicar y verificar el SQL; (2) solo entonces desplegar el emisor que envía `is_test`. Si el emisor fuera primero, la función antigua **ignora** claves desconocidas y guardaría un pedido de prueba como real.
- Cambio de WACRM (aparte): campo `is_test` en el pedido (casilla explícita en el formulario o configuración de la cuenta), inmutable como el resto del pedido, enviado siempre como booleano. Opcional: añadir `invalid_is_test` a la lista de códigos de la función edge (cosmético; requiere redesplegarla).

## 6. Riesgo de despliegue de Vercel al fusionar en `main`
- #6 solo añade archivos bajo `supabase/` (5 archivos nuevos, ninguno del frontend), pero la fusión en `main` crea igualmente un despliegue de «Producción» (precedentes `708fddf`, `eb41e5d`).
- **Probado:** un commit con `[skip ci]` en el mensaje **no** evita el despliegue (la rama de prueba generó su Preview). No es una mitigación.
- No consta si un despliegue de `main` sustituye al alias de producción; `main` construye el frontend de ejemplo, no el funcional.
- **Procedimiento seguro:** la migración se aplica **directamente a Supabase** (no depende de git ni de Vercel). **No fusionar #6 en `main` hasta confirmar en el panel de Vercel** qué rama es la de Producción y si «Auto-assign Production Domains» está activo, o configurar un *Ignored Build Step* que omita builds cuando solo cambia `supabase/`. Si se fusiona igualmente, tener a mano el *Instant Rollback* al despliegue de Producción vigente (el del commit `c026bf3`).

## 7. Procedimiento exacto de aplicación (no ejecutado; cada paso requiere autorización)
Frontend: **no se toca** (ningún paso usa git, Vercel ni el frontend).
0. Precondiciones: ventana de entrega de WACRM cerrada (`enabled = FALSE`, sin `INKACLICK_ORDERS_ENABLED`, sin cron), 2 pedidos `held` intactos.
1. **Respaldo nuevo** con `scripts/ops/inkaclick-backup.sh` (contraseña oculta) y huellas de `confirmed_orders` y `customers`.
2. **Línea base de funciones** (lectura): hash del cuerpo (espacios colapsados) de `sync_customer_from_confirmed_order` = `ea53d7a9833861f914da1fcf5562e7f0`; de `create_confirmed_order_from_wacrm` = `3cf7658a57c63ec05c4d3781a7b56050`; ACL de `confirmed_orders` `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`; ACL del receptor `{postgres=X/postgres,service_role=X/postgres}`; 5 disparadores; `is_test` inexistente. Si algo difiere, detener.
3. **Checksum del archivo** a aplicar (rama del PR): `sha256sum supabase/migrations/20261102000000_customer_sync_wacrm_semantics.sql` = `7236af5bb16586b428aa4612b932b91d5e3197fb12676419cc12c2c1bafc5251` (rollback: `27b6f6b289a354945ac2b1b8d6f1bc7820a5873164102837936d34baa1dac72d`). Si el archivo cambia, se recalculan y se vuelve a presentar.
4. **Aplicar en una transacción**: `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; <archivo íntegro>; INSERT INTO supabase_migrations.schema_migrations (version,name,statements) VALUES ('20261102000000','customer_sync_wacrm_semantics', ARRAY['aplicado literalmente desde InkaClick-Saas@<commit>, sha256 <hash>']); COMMIT;`. Si el `ALTER` no obtiene el bloqueo en 5 s, la transacción aborta sin dejar nada: reintentar fuera de hora punta.
5. **Verificación**: `is_test` existe (`NOT NULL`, default `false`, todas las filas `false`); hash de `sync` = `c8bf0201b2ec255b58a54dd6b015de39` y de `create_confirmed_order_from_wacrm` = `446abb5c015263eaecd8bf5b98dc4bd5`; ACL de la tabla y del receptor sin cambios; 5 disparadores; `anon`/`authenticated` sin `EXECUTE`; huellas de `confirmed_orders` (sin las columnas nuevas) y `customers` **iguales** a la línea base (la migración no toca filas); pruebas de humo de la función edge (sin token 401, token incorrecto 401, GET inexistente 404, **sin POST válido**); los 2 cron de InkaClick siguen programados.
6. **Opcional y aparte**: marcar el pedido E2E con `is_test = TRUE` (§4).
7. **Rollback** (si algo falla): en una transacción con `lock_timeout`, ejecutar `supabase/rollbacks/20261102000000_customer_sync_wacrm_semantics.down.sql`; verificar que los hashes vuelven a `ea53d7a9…` y `3cf7658a…` y que los permisos del receptor son los de la línea base. La columna `is_test` puede quedarse. No hay contadores que restaurar (la migración no reescribe ninguno).
8. Después: seguir con el emisor (§5) y los filtros (§3) antes de activar WACRM comercialmente.
