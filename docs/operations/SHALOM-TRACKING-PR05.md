# PR-05 · Shalom + tracking logístico (solo LOCAL)

Estado: **implementado localmente**, sin push, sin deploy, sin ninguna llamada a Shalom, sin credenciales.

| Clasificación | Estado |
|---|---|
| ARQUITECTURA DE TRACKING (modelo, RPC, poller, UI, alerta, notificación) | **TERMINADA Y VALIDADA LOCALMENTE** con proveedor fake |
| INTEGRACIÓN REAL CON SHALOM | **BLOQUEADA hasta verificar contrato/autorización** (no se pudo confirmar que la API sea oficial; el endpoint de InkaClick NO es un contrato aprobado) |
| COEXISTENCIA CON EL POLLER DE INKACLICK | **PRE-DEPLOY BLOCKER**: decidir qué sistema es dueño del polling antes de activar nada real |

## 1. Qué hace

`ready_for_dispatch` (PR-04) → **registrar guía** (`numero_orden` + `codigo`, manual, Logística o Supervisor) → **En origen** → **En tránsito** → **En destino** → **Entregado**.
WACRM consulta al proveedor, normaliza la respuesta (RAW Shalom → normalizado → estado WACRM), actualiza el MISMO pedido, muestra el tracking en Pedidos Confirmados, deja historial y detiene las consultas al llegar a Entregado.
Si el pedido permanece **15 días calendario (America/Lima)** En destino se genera **una** alerta interna por episodio; el seguimiento continúa hasta Entregado. PR-05A/B (ver `SHALOM-TRACKING-PR05AB.md`) añade, aparte, un mensaje al cliente en ese día 15 (switch por cuenta, default OFF) y la condición "En abandono" al día 20. Entregado logístico ≠ Pagado (PR-06).

PR-05 es **aditivo**: no modifica `order_logistics.status` ni ninguna migración / RPC / test de PR-01 a PR-04. El estado derivado de la lista (PR-05 si existe shipment, si no el de PR-04) se hace *envolviendo* el indicador de PR-04, sin editarlo.

## 2. Migraciones (nuevas, posteriores a PR-04)

| Orden | Archivo | Contenido |
|---|---|---|
| 1 | `20261204000009_order_shipment_settings.sql` | `order_shipment_settings` (`shalom_tracking_enabled` **default FALSE**, breaker global de credenciales), `order_shipments_access()`, `order_shipments_actor()` |
| 2 | `20261204000010_order_shipments_model.sql` | `order_shipments`, `order_shipment_events`, `order_shipment_polls`, `order_shipment_alerts`, guardas, RLS SELECT-only |
| 3 | `20261204000011_order_shipments_rpcs.sql` | register / correct / stop / refresh / claim / apply / release / breaker / purge |
| 4 | `20261204000012_notifications_shipment_alert.sql` | CHECK de `notifications.type` + `order_id` nullable (aditivo; `conversation_assigned` intacto) |
| 5 | `20261204000013_order_shipment_alert_rpcs.sql` | `evaluate_destination_alerts`, `acknowledge_shipment_alert`, notificación a Logística/Supervisor |

Una responsabilidad por tabla: **estado actual** (`order_shipments`), **historial funcional** append-only (`order_shipment_events`, deduplicado por índices únicos), **log técnico de consultas** con retención (`order_shipment_polls`) y **ciclo de vida de la alerta** (`order_shipment_alerts`, único por `(order_id, destination_episode, kind)`).

## 3. Reglas que garantiza la base de datos

* **Dos flags**: `logistics_mvp_enabled` (PR-01) **y** `shalom_tracking_enabled`. Sin fila de settings = OFF.
* **Roles**: Logística y Supervisor ven / registran / corrigen / refrescan / atienden alerta; **solo Supervisor detiene**. Commercial, viewer, sin área y routing `shared` no conceden nada. Cross-account imposible (RPC `SECURITY DEFINER` solo `service_role`, revalidan actor, cuenta, flags, área y pedido).
* **Claim**: `FOR UPDATE SKIP LOCKED` + `claim_token` + `lease`. Dos workers no consultan lo mismo.
* **Versionado de guía**: corregir sube `identifier_version`, reinicia el tracking, conserva el historial y descarta respuestas en vuelo de la versión anterior. Auditoría con valor anterior/nuevo **enmascarado** + hash corto.
* **Respuestas**: tardías / antiguas / de versión anterior / con claim perdido se registran como ignoradas y no pisan el estado. El mismo estado repetido no crea otro evento. **Nunca retrocede** automáticamente (se registra `regression_ignored`).
* **Estado desconocido**: no avanza; queda como excepción técnica visible.
* **Errores**: 404/422 → error de pedido (solo pasa a `requires_attention` tras la ventana configurable, nunca por un único 404); 429 y 5xx / timeout / JSON inválido / degradado → integración (backoff acotado; el 429 pausa el resto del tick); 401/403 / `shalom_auth_failed` → **error global de credenciales** (interruptor que pausa todas las consultas, sin culpar a ningún pedido). Un fallo de Shalom nunca rompe WACRM.
* **Alerta de 15 días**: día 0 = fecha de En destino que reporta Shalom (si existe; si no, la primera observación de WACRM). Día 14 no; día 15 (calendario Lima) sí, una sola vez por episodio, aunque haya muchos ticks / workers. Se evalúa aunque Shalom esté caído. Al llegar a Entregado queda `resolved` (motivo `delivered`), al corregir la guía `left_destination`, al detener `stopped`. Nunca se borra.
* **Notificación leída ≠ alerta atendida**: `notifications.read_at` vs `order_shipment_alerts.status`.

## 4. Configuración (centralizada, `src/lib/orders/shalom/config.ts`)

Todos son **DEFAULT QA / PROVISIONALES**, no un SLA productivo (no se conocen los límites reales de Shalom):
tick 15 min · En origen 3 h · En tránsito 3 h · En destino 12 h · lote 5 · timeout 30 s · lease 10 min · backoff 15/30/60/120/240/360 min · ventana de atención 24 h · refresco forzado ≥ 5 min · alerta 15 días · retención de polls 30 días · pausa por credenciales 60 min.
Se pueden acelerar para QA con `SHALOM_CONFIG_JSON` (JSON parcial; lo inválido se ignora).

| Variable | Efecto |
|---|---|
| `SHALOM_TRACKING_ENABLED=true` | **Kill switch global** del cron y del refresco forzado. Sin él NO se consulta ni se reclama nada (el reloj de alertas, solo-BD, sigue). |
| `SHALOM_PROVIDER=fake` | Proveedor local scripteado (ignorado en producción). Por defecto `not_configured` (jamás llama a nada). |
| `SHALOM_FAKE_SCENARIO_FILE` | JSON que el fake relee en cada consulta (`{"default":"origin","byNumber":{"40000001":"delivered"}}`). |
| `SHALOM_CONFIG_JSON` | Ajuste de QA de los valores provisionales. |

**No existe ninguna variable de credenciales Shalom** (ni API key, ni email, ni password): no se guardan en BD ni en el repo. El día que se autorice un proveedor real se registrará SOLO en `src/lib/orders/shalom/providers.ts` y sus secretos vivirán server-side.

## 5. Cron

`GET /api/orders/shalom/cron` con `x-cron-secret` (mismo patrón que `/api/orders/cron`; sin `pg_cron`). Preparado, **NO instalado**: `scripts/ops/shalom-cron/` (`flock -n`, cada 15 min). Detener de inmediato sin tocar Inbox / Pedidos Confirmados / PR-04: quitar `SHALOM_TRACKING_ENABLED` (o `shalom_tracking_enabled = false` por cuenta), o retirar el cron.

## 6. Operación local / QA

Arranque de la app (fake Shalom + OCR fake + simulador de Meta):

```powershell
cd C:\WACRM-LOCAL
$env:ORDER_OCR_PROVIDER = "fake"
$env:SHALOM_PROVIDER = "fake"
$env:SHALOM_TRACKING_ENABLED = "true"
$env:SHALOM_FAKE_SCENARIO_FILE = "C:\WACRM-LOCAL-QA\shalom-scenarios.json"
$env:NODE_OPTIONS = "--require C:/WACRM-LOCAL/scripts/qa/pr04-integrated/meta-sim.cjs"
npm run dev
```

| Comando | Qué hace |
|---|---|
| `node scripts/qa/pr05/seed.cjs prepare` | Activa el flag y crea 6 pedidos **realmente** `ready_for_dispatch` (A..F) pasando por el flujo real de PR-04 |
| `node scripts/qa/pr05/shalom-sim.cjs set <escenario> [numero]` | Cambia el escenario del fake (sin reiniciar): `origin transit destination delivered not_found invalid rate_limited credentials_401 credentials_403 server_500..504 timeout hang invalid_json degraded_auth degraded_login degraded_order unknown` (`destination@<ISO>` fija la fecha de llegada que reporta Shalom) |
| `node scripts/qa/pr05/run-cron.cjs [--make-due]` | Ejecuta UN tick (`--make-due` acelera los intervalos de 3 h / 12 h) |
| `node scripts/qa/pr05/advance.cjs <A..F> <días>` | Simula el paso de días En destino para la alerta de 15 días |
| `node scripts/qa/pr05/status.cjs` | Foto de solo lectura: shipments, alertas, notificaciones, escenarios |
| `node scripts/qa/pr04-integrated/seed.cjs cleanup` | Borra TODO el mundo QA (las cuentas en cascada) |

Pruebas automáticas: BD (`shipments-db.qa.test.ts`, 41), servicio + poller con reloj inyectable (`tracking.qa.test.ts`, 24), HTTP extremo a extremo contra la app en marcha (`shalom-http.qa.test.ts`, 5; **no ejecutarla durante un UAT manual**: el cron reclama todo lo vencido), mapeo / config / rutas / UI / notificaciones.

## 7. Rollback

* Lógico e inmediato: `SHALOM_TRACKING_ENABLED` fuera / `shalom_tracking_enabled=false` / retirar el cron. Nada de PR-01..PR-04 se ve afectado.
* Aplicación: volver al commit anterior de la rama; las tablas nuevas quedan inertes.
* **Sin DROP**: el historial (eventos, polls, alertas, shipments) se conserva. La migración de `notifications` solo amplía el CHECK y añade una columna nullable (inofensivo si se revierte el código).

## 8. Pendientes reales (antes de cualquier prueba / deploy real)

1. **Contrato / autorización de la API de Shalom** (¿oficial?, límites, SLA, costo, términos). Hasta entonces no hay proveedor real.
2. **Credenciales** (server-side, nunca browser ni repo): base URL, API key, usuario y clave de la cuenta Shalom del negocio, **solo cuando se autorice**.
3. **Guías de prueba** reales en cada estado (registrado, origen, tránsito, destino, entregado, inexistente).
4. **Quién es dueño del polling**: InkaClick consulta hoy las mismas guías (y se detiene en `en_destino`; WACRM sigue hasta Entregado). No activar polling real en WACRM mientras InkaClick consulte las mismas guías. InkaClick además envía hoy la plantilla `pedido_listo_en_agencia` al llegar a destino: evitar el doble aviso cuando se añada la plantilla al cliente.
5. Frecuencia y volumen reales (límites de Shalom + número de envíos activos) para sustituir los valores provisionales.
6. Decisiones de negocio abiertas que NO bloquean el tracking base: plantilla al cliente a los 15 días, cancelación tardía (flujo), reventa / no recogido, recuperación de pedidos antiguos.
