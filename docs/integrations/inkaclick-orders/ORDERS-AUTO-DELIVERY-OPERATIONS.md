# Entrega automática WACRM → InkaClick: operación, supervisión de las primeras 24 h y apagado de emergencia

Estado a 2026-11-01 11:10 UTC: **OPERATIVA solo para la cuenta piloto** (`4d04a2e0-62b8-4508-a046-4b125aa2e8db`). Instalada el 2026-11-01 11:05 UTC con autorización del propietario del proyecto. Este documento es la guía de operación; el diseño y la activación están en `ORDERS-AUTO-DELIVERY-ACTIVATION-PLAN.md`.

## 1. Qué está en marcha

| Pieza | Dónde | Qué hace |
|---|---|---|
| Cron de entrega | `/etc/cron.d/wacrm-orders` → `/usr/local/bin/wacrm-orders-cron.sh`, cada minuto con `flock -n` | Llama a `GET /api/orders/cron`: reparte los pedidos `pending` y reconcilia `sent → acknowledged`. Log: `/var/log/wacrm-orders-cron.log` (una línea por minuto, solo contadores) |
| Monitor de salud | `/etc/cron.d/wacrm-orders-health` → `/usr/local/lib/wacrm-orders/orders-health-monitor.sh`, cada 5 min | Solo lectura. Log: `/var/log/wacrm-orders-health.log`. No envía nada a ningún lado |
| Interruptor global | `INKACLICK_ORDERS_ENABLED=true` en `/opt/apps/wacrm/.env.local` (la URL y el token de InkaClick ya estaban) | Sin él el endpoint no hace nada |
| Interruptor de cuenta | `order_integration_settings.enabled` de la cuenta piloto | Solo las cuentas con `enabled = TRUE` se reparten. Las demás no tienen fila |
| Panel «Pedidos confirmados» | Inbox, imagen `orders-history-f75f9887` | Muestra el estado de cada pedido y se actualiza solo mientras haya pedidos en curso |

Lo que **no** hace: no libera los pedidos `held` (los dos pedidos históricos siguen en `held`, con 0 intentos, y ninguna función los mueve), no activa otras cuentas, no envía `is_test` (ver sección 6).

## 2. Resultado de la validación final (solo lectura, 11:10 UTC)

| # | Comprobación | Resultado |
|---|---|---|
| 1 | Tres ejecuciones programadas del cron | PASS: 11:06:02, 11:07:03 y 11:08:02 (intervalos de 61, 59 y 62 s), todas `rc=0 200` con `claimed:0` |
| 2 | Monitor sin `O10` ni otras alertas | PASS: corrida programada de las 11:10:01 `OK accounts_delivery_on=1 acknowledged=2 held=2`. `O10` apareció solo mientras no había cron (10:50–11:05 en el log) |
| 3 | Cuenta piloto habilitada y las demás no | PASS: 1 fila de configuración (`enabled` y `confirm_enabled` en TRUE) para 1 de 4 cuentas; las otras 3 no tienen fila |
| 4 | Dos `held` con 0 intentos | PASS: 0 intentos, sin envío y sin filas de entregas |
| 5 | Sin `pending` atrasados, `sending` atascados, `failed`, `dead` ni `sent` sin reconocer | PASS: 0 pedidos en esos estados; `O1`–`O7` en 0 |
| 6 | Aplicación healthy sin reinicios | PASS: `orders-history-f75f9887`, healthy, 0 reinicios, no OOM, 0 errores en logs de 15 min |
| 7 | Historial y demás cron | PASS con límite: las rutas del panel responden 401 sin sesión (vivas); `wacrm`, `wacrm-alerts` y `wacrm-bsuid-watch` escribieron `OK` hace segundos. **No** se probó el panel con una sesión en esta auditoría |

## 3. Supervisión de las primeras 24 horas

Nada vigila por sí solo con aviso activo: el monitor **escribe un log local y no envía nada**. Hay que revisarlo a mano. Calendario sugerido, contado desde las 11:05 UTC del 2026-11-01:

| Cuándo | Qué revisar |
|---|---|
| +15 min, +1 h, +4 h, +12 h y +24 h | Los comandos de la sección 3.1 |
| Cada vez que alguien confirme un pedido en la cuenta piloto | El panel debe pasar de «pendiente de envío» a «Enviado» y a «Recibido en InkaClick» en 1–2 min |
| A las 24 h | Criterios de cierre de la sección 3.3 |

### 3.1 Comprobación rápida (solo lectura, 1 minuto)
```bash
date -u
tail -5 /var/log/wacrm-orders-cron.log                      # una línea por minuto, todas "rc=0 200"
grep -c ' rc=[1-9]' /var/log/wacrm-orders-cron.log           # debe ser 0
tail -3 /var/log/wacrm-orders-health.log                     # "OK ..." cada 5 min; cualquier ALERT / STILL_FIRING / MONITOR_ERROR es un problema
/usr/local/lib/wacrm-orders/orders-health.sh                 # O1..O7 en 0; I_held 2
docker inspect wacrm-app-1 --format '{{.State.Health.Status}} restarts={{.RestartCount}}'   # healthy, 0
docker exec supabase-db psql -U postgres -d postgres -At -c "select delivery_status, count(*), sum(attempts) from order_confirmations group by 1 order by 1"
```
Esperado en reposo: `acknowledged` (2 hoy), `held 2` con 0 intentos, nada más. Con tráfico: cada pedido nuevo pasa `pending → sent → acknowledged` en 1–2 minutos.

### 3.2 Qué hacer según la alerta

| Alerta | Significado | Primera acción |
|---|---|---|
| `O1_failed` | InkaClick rechazó un pedido (4xx). **No se reintenta solo** | Leer el motivo: `select attempt, outcome, http_status, error_code from order_confirmation_deliveries where order_id = '<id>'`. Avisar; el reenvío es manual y lo decide una persona |
| `O2_dead` | 8 intentos agotados | Igual que `O1`; comprobar primero que InkaClick responda |
| `O3_pending_late` | Un `pending` lleva más de 5 min | ¿Existe `/etc/cron.d/wacrm-orders` y su log avanza? ¿La variable global vale `true`? ¿InkaClick responde? |
| `O4_sending_stuck` / `O7_open_attempts_stale` | Una pasada murió a medias | El siguiente reclamo lo recupera solo. Si persiste 10 min, revisar los logs de `app` |
| `O5_sent_not_acknowledged` | Enviado y sin reconocer 10 min | InkaClick no devuelve el pedido en la consulta de reconciliación: comprobar en InkaClick si existe la fila `source='wacrm'` |
| `O6_held_touched` | **Un `held` se movió.** No debería ser posible | **Apagado de emergencia inmediato** (sección 4) y avisar |
| `O8_cron_silent` / `O8_cron_log_missing` | El cron no se ejecuta o no escribe | `systemctl is-active cron`; revisar el archivo `/etc/cron.d/wacrm-orders` (644, root) |
| `O9_cron_last_run_failed` | La última pasada no fue `rc=0` | `tail -3 /var/log/wacrm-orders-cron.log`: un `401` es el secreto; un `503` es que falta `AUTOMATION_CRON_SECRET`; un `500`, mirar `docker logs wacrm-app-1` |
| `O9_endpoint_disabled_with_active_account` / `O9_global_switch_off_with_active_account` | La integración está apagada con una cuenta activa | Revisar `INKACLICK_ORDERS_ENABLED`, la URL y el token. Si el apagado fue intencionado, apagar también la cuenta (sección 4.1) |
| `O10_account_on_without_cron` | Cuenta activa sin cron | Instalar el cron o apagar la cuenta |

### 3.3 Criterios de cierre de las 24 horas
- 0 alertas `O1`–`O10` en el log del monitor (más allá de la ventana de instalación).
- Cron: ~1440 líneas, todas `rc=0 200`, sin huecos de más de 2 minutos.
- Todos los pedidos nuevos en `acknowledged` en menos de 5 minutos.
- Los dos `held` siguen con 0 intentos.
- `app` sin reinicios inesperados y sin errores de pedidos en los logs.
- Los pedidos reales llegaron a InkaClick con los datos correctos (comprobación por una persona).

Con eso se puede discutir ampliar a más cuentas, que requiere su propia autorización y no está incluido aquí.

## 4. Apagado de emergencia

Tres palancas independientes, de menor a mayor impacto. **Ninguna toca los `held`, borra pedidos ni afecta al Inbox, salvo la C.** Tras cualquiera de ellas, comprobar con la sección 3.1.

### 4.1 A. Interruptor de la cuenta (instantáneo, sin reinicio): detiene los reclamos
```sql
UPDATE public.order_integration_settings SET enabled = FALSE WHERE account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db';
```
```bash
docker exec supabase-db psql -U postgres -d postgres -c "UPDATE public.order_integration_settings SET enabled = FALSE WHERE account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db'"
```
Efecto: no se reclama nada más. Los pedidos nuevos nacen `held` (no se enviarán solos). Los `pending` que ya existan esperan; un envío en curso termina. Con ninguna cuenta habilitada el monitor deja de exigir cron y endpoint (una integración apagada a propósito es saludable); solo avisará `O3` si quedan `pending` sin repartir.

### 4.2 B. Quitar el cron (instantáneo, sin reinicio): se deja de llamar al endpoint
```bash
rm /etc/cron.d/wacrm-orders
```
Efecto: nada reparte ni reconcilia. Los `pending` esperan; los `sent` quedan sin reconocer (el monitor avisará `O5` y `O10`). Para reanudar: volver a instalar el archivo desde `scripts/ops/orders-cron/wacrm-orders.cron.d`.

### 4.3 C. Interruptor global (reinicia `app`, unos segundos de corte del Inbox): solo si A y B no bastan
```bash
# 1) copia de seguridad del entorno
B=/opt/backups/wacrm/emergency-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p $B && chmod 700 $B && cp -p /opt/apps/wacrm/.env.local $B/env.local
# 2) quitar la línea
sed -i '/^INKACLICK_ORDERS_ENABLED=true$/d' /opt/apps/wacrm/.env.local
# 3) recrear solo app con la misma imagen y los mismos -f que el contenedor actual
cd /opt/apps/wacrm && F=$(docker inspect wacrm-app-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | sed 's/,/ -f /g') && docker compose -f $F up -d --no-deps app
```
Efecto: el endpoint responde `{"enabled":false,...}` para todas las cuentas.

### 4.4 Después de apagar
- Un pedido ya recibido por InkaClick **no se borra**: se anula con el flujo de anulación de InkaClick.
- Anotar la hora, la palanca usada y el motivo.
- Para reanudar: revertir la palanca (en orden inverso) y repetir 3.1. No hace falta repetir la activación completa.
- Rollback de la imagen de la aplicación (si el problema fuera el código): recrear `app` con `/opt/backups/wacrm/pre-orders-20261031T154613Z/wacrm-orders-image2.yml` (imagen `orders-1246621b`, sin el panel; la entrega sigue funcionando porque no depende de él).

## 5. Qué es un pedido nuevo en la cuenta piloto

Un pedido confirmado en el Inbox de la cuenta piloto nace `pending` (no `held`) y sale solo en el siguiente minuto. Llega a InkaClick como pedido real: los informes, la logística y los avisos de InkaClick no lo distinguen de un pedido de ManyChat. Cada pedido de prueba debe avisarse a Logística.

## 6. Pedidos de prueba y la ficha del cliente

WACRM todavía no envía `is_test`. Un pedido de prueba se marca a mano en InkaClick **después** de recibirse, con una autorización aparte y una transacción que verifique que solo cambia ese pedido:
```sql
UPDATE public.confirmed_orders SET is_test = TRUE
 WHERE source = 'wacrm' AND external_order_id = '<id del pedido en WACRM>' AND NOT is_test;   -- exactamente 1 fila
```
La marca no revierte lo que el pedido ya hizo en la ficha del cliente: un pedido de prueba enviado como real suma +1 a `total_pedidos` y actualiza `ultimo_pedido_at` de su cliente. Si se quiere restaurar la ficha, se hace con una transacción protegida aparte (plantilla: `scripts/ops/inkaclick-phase4-restore-customer.sql`).

## 7. Datos de referencia

- Cuenta piloto: `4d04a2e0-62b8-4508-a046-4b125aa2e8db`. Imagen en producción: `wacrm-app:orders-history-f75f9887` (rollback `orders-1246621b`).
- Respaldos: `/opt/backups/wacrm/pre-order-history-*`, `/opt/backups/wacrm/pre-orders-global-switch-*`.
- Pedido de prueba piloto: `24c96568-84bd-4d2c-a5d4-21edd36d7b5d` (InkaClick `8264de30-…`, `is_test = TRUE`). Imagen previa de la ficha: `/opt/backups/inkaclick/secrets/customer-pre-image-pilot-order-*.json`.
- Backoff de reintentos: 30 s → 1 min → 2 min … tope 1 h, 8 intentos; 10 pedidos por pasada; lease de 120 s.
