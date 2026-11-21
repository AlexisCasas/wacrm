# Proveedor real de Shalom (PR-05 · `shalom_http`)

Estado: **implementado solo en local** (rama `feat/shalom-real-provider`). Sin deploy, sin credenciales reales, sin ninguna llamada a Shalom ni al servicio intermedio, sin cron instalado, sin flags activados. Nada de esto cambia el comportamiento de producción hasta que se configure y se active a propósito.

## 1. Qué es y qué NO es

WACRM se conecta al **servicio intermedio de tracking que hoy usa InkaClick** (contrato descubierto en una auditoría de solo lectura del código y de las respuestas guardadas de InkaClick). **No es un contrato oficial de Shalom** y no está confirmado por Shalom. Antes de la primera prueba real hay que confirmar con su dueño: autorización y términos de uso, límites reales, y los puntos de §9.

## 2. Contrato HTTP

```
GET {SHALOM_BASE_URL}/v1/tracking?numero=<numero>&codigo=<codigo>
Accept: application/json
Content-Type: application/json
X-API-Key: <SHALOM_API_KEY>
X-Shalom-Email: <SHALOM_EMAIL>
X-Shalom-Password: <SHALOM_PASSWORD>
```

* Una sola consulta de solo lectura por guía. Sin cuerpo. Sin seguir redirects (`redirect: 'manual'`: un 3xx es un error de integración y las credenciales nunca se reenvían a otro host).
* `numero` (hoy 6–12 dígitos; en datos reales casi siempre 8–9) y `codigo` (3–6 caracteres A-Z0-9; casi siempre 4) viajan como `URLSearchParams`.
* Respuesta 200 (forma real observada): `{ status: { registrado, origen{fecha}, transito{carguero, cargueros, fecha, completo}, destino{fecha, completo}, entregado, reparto, demora }, order{…}, detailed, degraded_reason? }`. `order` trae datos del cliente y montos: **el proveedor los descarta** (§6).

## 3. Variables (solo servidor; nunca `NEXT_PUBLIC`)

| Variable | Estado | Secreta | Nota |
|---|---|---|---|
| `SHALOM_PROVIDER` | existente | no | `shalom_http` selecciona el proveedor real. `fake` solo fuera de producción. Cualquier otro valor = `not_configured`. |
| `SHALOM_BASE_URL` | **nueva** | no | https obligatorio (http solo para `localhost` fuera de producción). Sin usuario/clave ni query dentro de la URL. |
| `SHALOM_API_KEY` | **nueva** | **sí** | |
| `SHALOM_EMAIL` | **nueva** | **sí** | |
| `SHALOM_PASSWORD` | **nueva** | **sí** | |
| `SHALOM_TRACKING_ENABLED` | existente | no | Kill switch global: sin `true` exacto no se consulta ni se reclama nada. |
| `SHALOM_CONFIG_JSON` | existente | no | Ajuste de los valores provisionales (§7). |

`resolveShalomProvider()` elige `shalom_http` **solo** si `SHALOM_PROVIDER=shalom_http` y las cuatro variables están presentes y válidas; si falta cualquiera resuelve `not_configured` (fail closed, jamás se envían credenciales parciales). Elegirlo no hace ninguna llamada: solo consulta Shalom el cron con `SHALOM_TRACKING_ENABLED=true` y los flags de cuenta (`logistics_mvp_enabled` y `shalom_tracking_enabled`) activos.

## 4. Mapeo (sin cambios: `normalize.ts` / `classify.ts`)

| Respuesta | Estado WACRM |
|---|---|
| `registrado` / `origen` | En origen (`at_origin`) |
| `transito.completo` | En tránsito (`in_transit`) |
| `destino.completo` o `destino.fecha` | En destino (`at_destination`) |
| `order.entregado === true` | Entregado (`delivered`) |
| forma irreconocible | `unknown_state` (no avanza; excepción técnica visible) |

**`status.entregado` NO es terminal por sí solo.** Hay 45 casos reales donde `status.entregado` es un objeto con fecha pero `order.entregado` es false o falta: **PENDIENTE DE CONFIRMACIÓN CON SHALOM**. Hasta entonces esos casos quedan en su último estado (nunca Entregado). Si Shalom confirma que ese objeto significa entrega, es un cambio de una línea en `normalize.ts` (+ tests).

## 5. Errores

| Situación | Resultado | Tratamiento |
|---|---|---|
| 404 / `error.code = not_found` | `not_found` | Error de pedido; solo pide atención tras `attentionWindowHours` (nunca por un único 404) |
| 400 / 422 | `invalid_identifier` | Error de pedido |
| 401 / 403 | `credentials` | Breaker global: pausa todas las consultas `credentialsPauseMinutes` |
| 429 | `rate_limited` | Pausa por `Retry-After` (segundos o fecha HTTP) acotada a [1, 900] s; sin él, `rateLimitPauseSeconds.fallback`. Devuelve el resto del lote |
| 408 / timeout / `AbortSignal` | `timeout` | Backoff por pedido |
| red | `server_error` (`network_error`) | Backoff por pedido |
| 5xx, 3xx, otros | `server_error` | Backoff por pedido |
| 200 con JSON inválido / vacío / no objeto / > 1 MB | `invalid_json` | Error de integración |
| 200 + `degraded_reason = shalom_auth_failed` | `credentials` | Breaker global |
| 200 + `degraded_reason = shalom_login_unavailable` | `degraded_integration` | Error de integración, **sin** breaker global |
| 200 + `degraded_reason = orden_no_disponible` | `degraded_order` | Error de pedido (ventana de atención) |
| 200 + `degraded_reason` desconocido | `degraded_integration` | Culpa de la integración, no del pedido |

En los datos reales de InkaClick: `shalom_auth_failed` (621) solo en septiembre; `shalom_login_unavailable` (315) intermitente hasta hoy; `orden_no_disponible` (156) en noviembre. No hay 429 en el historial.

## 6. Seguridad

* Las credenciales solo existen como variables de entorno del servidor, solo se leen en `providers.ts` y solo viajan en los headers de la petición. No hay `console.*` en el proveedor, ningún error lanzado las contiene (solo un código de máquina) y ningún valor devuelto las incluye. Hay tests que lo comprueban con valores centinela sobre todos los escenarios.
* **Minimización**: antes de salir del proveedor, la respuesta se reduce a lo que lee el clasificador (banderas y fechas de `status`, `order.entregado`, `degraded_reason`, `error.code`). Remitente, destinatario, montos, contenido, comprobante, transportista, identificadores… se descartan: no se pueden guardar ni registrar. En un error solo sobrevive el código de máquina.
* Guardas con test: ninguna variable `SHALOM*` con prefijo `NEXT_PUBLIC`; ni `next.config.ts` ni el `Dockerfile` las nombran; los secretos se leen solo en `providers.ts`; ningún componente cliente importa los módulos del proveedor; con `NODE_ENV=production` nunca se resuelve el proveedor `fake`.
* Kill switch: `SHALOM_TRACKING_ENABLED` (recrear la app), `shalom_tracking_enabled` por cuenta (inmediato, por SQL) o retirar el cron.

## 7. Configuración recomendada para la PRIMERA prueba real (provisional; todo ajustable con `SHALOM_CONFIG_JSON`, sin cambiar código)

```json
{"timeoutMs":120000,"batchSize":5,"leaseSeconds":1500,"tickMinutes":15}
```

* **Timeout ≈ 120 s**: el servicio intermedio inicia sesión en Shalom por su cuenta; InkaClick usa 120 s. El default de WACRM (30 s) probablemente se queda corto.
* **Lease > `batchSize × timeout` + margen**: un claim sin terminar dentro del lease puede ser retomado por otro proceso. Con 5 × 120 s = 600 s el lease por defecto (600 s) NO alcanza: usar 1500 s. `shalomConfigWarnings()` (config.ts) avisa de esta inconsistencia y de ticks cuyo peor caso supera el intervalo.
* **`batchSize` / tick**: pendientes de definir con los límites reales. Con los defaults (lote 5, tick 15 min) el máximo es unas 480 consultas/día; con ~50 pedidos/día y ~5 días de vida por guía harían falta unas 2000. Subir lote o acortar el tick según los límites que confirme el servicio.
* Los demás valores (`intervalMinutes`, backoff, ventana de atención, alertas) siguen siendo **provisionales**.

## 8. Requisitos de migración (para cuando WACRM tome el control; NO se hace en este cambio)

1. **Apagar en InkaClick** (solo cuando WACRM esté probado y activo): el job `sync-shalom-statuses` (hoy cada 15 min) y el job `notify-destination-vouchers` (hoy en los minutos 5 y 35 de cada hora). Nada de eso se toca ahora.
2. **Aviso al llegar a destino.** InkaClick envía hoy la plantilla `pedido_listo_en_agencia` en cuanto una guía llega a destino. **Antes de apagar InkaClick, WACRM deberá tener una comunicación equivalente usando Meta y el mismo número actual de WACRM**, para no perder ese comportamiento. Es independiente del mensaje del día 15 (`destination_customer_message_enabled`) y se diseña y valida por separado.
3. El tracking Shalom funciona aunque Meta esté OFF; el mensaje al cliente se conecta después y por separado.
4. No consultar las mismas guías desde ambos sistemas a la vez: una guía solo la consulta quien sea su dueño de polling (decisión cerrada: WACRM).

## 9. Pendiente con Shalom / el dueño del servicio intermedio

* Autorización y términos de uso desde WACRM; a quién pertenece el servicio y quién responde por él.
* Límites reales (rate limit, latencia, volumen) y política de `Retry-After`.
* Significado de `status.entregado` como objeto con `order.entregado` false/ausente (45 casos).
* Semántica y causa de `orden_no_disponible` y de `shalom_login_unavailable`.
* Si exige lista de IP permitidas (la IP de salida del VPS se aportaría llegado el caso).
* Guías reales de prueba (1–3) en estados distintos y una inexistente.

## 10. SECURITY ACTION pendiente (no ejecutada)

**Rotar el `CRON_SECRET` de InkaClick.** Quedó expuesto en una salida de herramienta durante la auditoría de solo lectura (no se copió a ningún archivo ni a WACRM). Además está guardado en texto plano dentro de la definición de los crons de la base de InkaClick. No se rota en este cambio: es una acción pendiente, a cargo de quien administra InkaClick.
