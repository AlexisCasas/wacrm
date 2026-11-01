# Entrega automática WACRM → InkaClick: auditoría y plan de activación (solo cuenta piloto)

Estado: **plan y herramientas preparadas. Nada está instalado ni activado.** Es un cambio productivo **separado** del historial de pedidos (PR #60): este plan solo empieza cuando el historial esté desplegado y validado por ti con tu sesión real. Cada paso `[AUTORIZAR]` espera tu autorización.

## 1. Auditoría (código y base, solo lectura)

| Pregunta | Hallazgo |
|---|---|
| **Endpoint y secreto** | `GET /api/orders/cron` exige la cabecera `x-cron-secret` igual a `AUTOMATION_CRON_SECRET`, comparada en tiempo constante y por longitud; sin variable responde 503, con secreto erróneo 401. Es el **mismo secreto** que los demás cron. En el contenedor está definido (64 caracteres). El script programado lo lee del entorno del contenedor con `docker exec`: no se copia, no se escribe en un archivo ni se imprime |
| **Interruptor global** | Solo actúa si `INKACLICK_ORDERS_ENABLED=true` **y** hay URL y token. Hoy: URL y token definidos, `ENABLED` sin definir → el endpoint responde `enabled:false` y no reclama nada |
| **Qué reclama** | `claim_order_deliveries` toma solo pedidos `pending` vencidos o `sending` con lease expirado, **de cuentas con `order_integration_settings.enabled = TRUE`**. Un pedido es `pending` solo si se creó con el interruptor encendido; con él apagado nace `held`. **Nunca** reclama `held`: ni al encender el interruptor ni después (el paso `held → pending` no existe en ninguna función). Hoy hay 0 `pending`, 2 `held` (0 intentos) y 1 `acknowledged` |
| **Límites por pasada** | 10 pedidos, lease de 120 s, 8 intentos como máximo, espera 30 s → 1 min → 2 min … tope 1 h con variación ±20 %, y se respeta `Retry-After` |
| **Reconciliación** | Después de repartir, el mismo endpoint consulta por `GET ?external_order_id=` los pedidos `sent` con más de 60 s y los pasa a `acknowledged` solo si InkaClick confirma que tiene ese id. Con un cron por minuto: el envío ocurre en la pasada N y el reconocimiento en la N+1 o N+2 (≈1–2 min). Se probó con una prueba de dos ejecuciones y, en producción, el 31-oct con el pedido E2E |
| **Convención de cron existente** | Cada cron va en su **propio archivo** de `/etc/cron.d`, ejecuta un script de `/usr/local/bin` que hace `docker exec` y llama a `http://127.0.0.1:3000/...`, con `flock -n` y un log propio. Activos hoy: `wacrm` (barrido de 5 min), `wacrm-alerts` y `wacrm-bsuid-watch`; `wacrm-flows` está preparado y **no** instalado. Nada de lo nuevo toca esos archivos |
| **Solo cuenta piloto** | La entrega es por cuenta (`enabled`). Solo la cuenta piloto (`4d04a2e0-…`) tiene fila de configuración, con `confirm_enabled = TRUE`. Las demás no tienen fila: no pueden crear pedidos (botón y endpoint apagados) y el reclamo las ignora aunque el interruptor global esté encendido. Verificado en una base desechable con otra cuenta con `pending` forzado |
| **Apagado inmediato** | Ver la sección 5. Hay tres palancas independientes; las dos primeras no reinician nada |

## 2. Herramientas preparadas (en este PR; no instaladas)

| Archivo | Para qué |
|---|---|
| `scripts/ops/orders-cron/wacrm-orders-cron.sh` | Una llamada por minuto al endpoint. Escribe una línea con solo contadores (`rc=0 200 {"enabled":true,"claimed":0,…}`), sin nombres, DNI ni teléfonos. Tope de 100 s |
| `scripts/ops/orders-cron/wacrm-orders.cron.d` | Línea del cron: `* * * * *` con `flock -n`, en su propio archivo `/etc/cron.d/wacrm-orders` |
| `scripts/ops/orders-cron/orders-health.sql` / `orders-health.sh` | **Solo SELECT.** Los controles de la sección 4 |
| `scripts/ops/orders-cron/orders-health-monitor.sh` + `wacrm-orders-health.cron.d` | Monitor cada 5 min con el mismo patrón que `alerts-p8-monitor.sh`: un bloqueo, intervalo mínimo, una línea de log local, repetición limitada, no envía nada a ningún lado |
| `scripts/ops/orders-cron/wacrm-orders.logrotate` | Rotación semanal de los dos logs |
| `scripts/qa/orders-delivery/` | QA en base desechable (sin red): 25 comprobaciones PASS del reclamo, los `held`, la reconciliación y cada control de salud |

## 3. Pruebas ya ejecutadas

| Prueba | Resultado |
|---|---|
| Base desechable: encender el interruptor de la cuenta **no** reclama los `held`; no hay entregas ni intentos | PASS |
| Un pedido nuevo de la cuenta piloto se reclama una sola vez; una segunda pasada no lo reclama mientras dure el lease | PASS |
| Un `pending` de una cuenta sin interruptor no se reclama | PASS |
| `held` nunca pasa a `acknowledged` ni se puede cerrar con `finish_order_delivery` | PASS |
| `failed` no se vuelve a reclamar; el cierre duplicado de un intento se ignora | PASS |
| Controles O1–O7: cada uno se dispara exactamente en su estado, no antes del umbral, y calla en estado limpio | PASS (12) |
| Monitor: avisa si el cron está instalado y su log falta o lleva más de 5 min sin escribir | Comprobado a mano en rutas de prueba (cron ausente, log faltante, log parado 20 min); no está automatizado |
| Vitest: entrega en una pasada y `sent → acknowledged` en una pasada posterior, sin reenviar | PASS |
| Estado productivo actual con `orders-health.sh` (solo lectura) | Sin alertas: 2 `held`, 1 `acknowledged`, 0 cuentas con entrega |

## 4. Controles (qué se vigila y qué significa)

| Código | Se dispara cuando | Acción |
|---|---|---|
| `O1_failed` | hay un pedido `failed` (InkaClick lo rechazó, 4xx) | Revisar el motivo en `order_confirmation_deliveries`; requiere una persona |
| `O2_dead` | hay un pedido `dead` (8 intentos agotados) | Revisar y decidir reenvío manual |
| `O3_pending_late` | un `pending` lleva más de 5 min vencido | El cron no corre, el interruptor global está apagado o InkaClick falla |
| `O4_sending_stuck` | un `sending` con el lease expirado más de 5 min | Una pasada murió a medias; el siguiente reclamo lo recupera. Si persiste, revisar |
| `O5_sent_not_acknowledged` | un `sent` lleva más de 10 min sin reconocer | La consulta de reconciliación falla o InkaClick no lo encuentra |
| `O6_held_touched` | un `held` con intentos, fecha de envío o entregas | **Crítico:** un pedido retenido se movió. Apagar la entrega |
| `O7_open_attempts_stale` | un intento «started» de más de 5 min | Pasada interrumpida |
| `O8_cron_silent` / `O8_cron_log_missing` | el cron está instalado y su log no se escribe | El cron no se ejecuta |
| `O9_cron_last_run_failed` | la última línea del log del cron no es `rc=0` | Secreto, contenedor o endpoint con error |

Límite: el monitor **escribe un log local y no envía nada** (igual que los de alertas existentes). Para recibir un aviso activo hay que decidir un canal (correo o WhatsApp interno); no lo he añadido.

## 5. Apagado inmediato (sin afectar el Inbox ni otros cron)

| Palanca | Comando | Efecto | Reinicio |
|---|---|---|---|
| **A. Interruptor de la cuenta** | `UPDATE public.order_integration_settings SET enabled = FALSE WHERE account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db';` | Inmediato: no se reclama nada más. Los pedidos nuevos nacen `held`. Los ya `pending` esperan. Un envío en curso termina. El Inbox no se entera | No |
| **B. Quitar el cron** | `rm /etc/cron.d/wacrm-orders` | Inmediato: se deja de llamar al endpoint. Los demás cron no se tocan | No |
| **C. Interruptor global** | Quitar `INKACLICK_ORDERS_ENABLED` de `.env.local` y recrear `app` con la misma imagen | El endpoint responde `enabled:false` para todas las cuentas | **Sí:** unos segundos de corte del Inbox. Solo si A y B no bastaran |

Tras cualquiera de ellas, los 2 `held` siguen en `held` con 0 intentos. Un pedido ya recibido por InkaClick no se borra: se anula con su flujo de anulación.

## 6. Plan exacto de activación

### Condiciones previas (no se empieza sin las tres)
1. El historial (PR #60) está desplegado y **validado por ti con tu sesión real** (`ORDER-HISTORY-PANEL-DEPLOY-PLAN.md`, 3.4).
2. **Decisión sobre el primer pedido.** WACRM todavía no envía `is_test`, y los informes, la logística y los avisos de InkaClick no filtran esa marca: cualquier pedido de la cuenta piloto llega a InkaClick como un pedido real. Opciones: (a) el primer pedido lo haces tú con tu propio contacto y un producto «PRUEBA … NO DESPACHAR», y después marcamos `is_test = TRUE` con una autorización aparte, igual que con el E2E; (b) un pedido real autorizado. Recomiendo (a).
3. Línea base de InkaClick y WACRM en solo lectura (conteos y huellas de `confirmed_orders` y `customers`, 2 `held`), para comparar al final.

### Pasos (cada uno `[AUTORIZAR]`)
| # | Paso | Verificación | Si falla |
|---|---|---|---|
| 1 | Instalar el monitor y la rotación de logs (solo lectura): copiar scripts a `/usr/local/lib/wacrm-orders/` y `/usr/local/bin/`, y los dos archivos `.cron.d` / `.logrotate`. **Aún sin el cron de entrega** | El log muestra `OK accounts_delivery_on=0 acknowledged=1 held=2`; ningún otro cron cambia | `rm /etc/cron.d/wacrm-orders-health` |
| 2 | Ventana de entrega: copia de `.env.local`, añadir `INKACLICK_ORDERS_ENABLED=true`, recrear solo `app` con la **misma imagen** (los mismos cuatro `-f`). La cuenta sigue en `enabled = FALSE` | `app` healthy, 0 reinicios nuevos; una llamada manual al script devuelve `rc=0 200 {"enabled":true,"claimed":0,"sent":0,…}` | Restaurar `.env.local` y recrear (palanca C) |
| 3 | Encender la cuenta piloto: `UPDATE … SET enabled = TRUE WHERE account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db'` | 0 `pending`, 2 `held` sin cambios; una pasada manual devuelve `claimed:0` | Palanca A |
| 4 | **Un pedido** confirmado por ti en el Inbox (según la decisión 2). Queda `pending` | El panel lo muestra «pendiente de envío»; `orders-health.sh` sin alertas | Palanca A |
| 5 | **Una pasada manual** del script: debe dar `claimed:1, sent:1`. Comprobar en InkaClick la fila `source='wacrm'` y el efecto sobre el cliente | El panel pasa a «Enviado»; el cliente no pierde historial (regla de la migración #6) | Palanca A y revisar |
| 6 | Esperar más de 60 s y otra pasada manual: `reconciled:1` | El panel muestra «Recibido en InkaClick» | No avanzar; revisar `O5` |
| 7 | Instalar `/etc/cron.d/wacrm-orders` (cada minuto) | Cada minuto una línea `rc=0`; sin alertas; sin envíos duplicados; los 2 `held` intactos | Palanca B |
| 8 | Observar 24 h con la cuenta piloto. Criterios de salida: 0 alertas `O1`–`O9`, ningún `held` movido, todos los pedidos nuevos en `acknowledged` en menos de 5 min | Informe PASS/FAIL | Palanca A o B |

Si en el paso 4 se hace un pedido de prueba, el `is_test = TRUE` en InkaClick se aplica **después** y con su propia autorización.

### Qué no hace este plan
No libera los 2 `held`, no activa otras cuentas, no desarrolla `is_test` (ni en el emisor ni en los filtros de InkaClick), no amplía las pruebas de duplicados, no toca ManyChat ni el frontend de InkaClick y no modifica los cron existentes.

## 7. Riesgos abiertos

- **Pedidos de prueba y reales indistinguibles hasta el siguiente cambio:** WACRM no envía `is_test`; la mitigación es marcar a mano, como el E2E.
- **Avisos pasivos:** los controles escriben un log local; si nadie lo mira, una alerta pasa desapercibida. Recomiendo decidir un canal antes de ampliar a más cuentas.
- **El interruptor global necesita un reinicio breve de `app`** para activarse (paso 2) y para apagarse (palanca C).
- **Sin ensayo de carga:** una cuenta con muchos pedidos simultáneos se entrega a 10 por minuto; con la cuenta piloto no es un problema.
