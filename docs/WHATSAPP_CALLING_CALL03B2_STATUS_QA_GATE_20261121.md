# WACRM — WhatsApp Calling: estado y gate de QA (21/nov/2026)

**Control de cambios:** registro de handoff técnico. Este documento se escribió desde GitHub sobre la rama de CALL-03B2.5. **No es evidencia de despliegue a la VPS.**
**Decisión vigente:** desarrollo y checks automatizados PASS; **NO-GO para merge, QA mutante, producción y Meta real** hasta completar preflight, respaldo y QA aislado aprobado.

## 1. Alcance implementado y evidencia

| Tramo | Avance | Fuente / límite |
|---|---|---|
| CALL-01/02 | Integración base, permisos y persistencia de eventos Calling | PRs #134 y #136; aún sin merge |
| CALL-03A/03B | Inbox, signaling WebRTC, llamadas BIC/UIC y trazabilidad por agente | PRs #137/#138/#140; mock de Graph separado en #141 SOLO QA |
| CALL-03B2.3 | Duración autoritativa, inicio/fin, rechazo y no atendida | QA Firefox 148 aislado **reportado**: cinco escenarios funcionales; PR #142, base `9bc35479` |
| CALL-03B2.4 | `claim` antes de `getUserMedia`, heartbeat, abortos y concurrencia cliente | PR #143, `90bd9a0cbac54fbdc16d8dc1711c3912fe70dc96`; CI #44917535711 PASS, **4.717 tests PASS**, 215 omitidos, Next build PASS |
| CALL-03B2.5 | Reserva atómica de `terminate`/`reject` antes de Meta; bloqueo del claim, resultado `unknown` sin reintento | PR #144, código `166c50edee0e8d7944827e03256663de1d22382d`; CI #44919411327 PASS, **4.723 tests PASS**, 215 omitidos; Migrations #44919411348 PASS |

En el último cierre **reportado por Claude desde la VPS**, el QA CALL-03B2.3 tenía 23 sesiones (18 históricas + 5 nuevas), 0 llamadas activas, 0 claims y 0 SDP pendientes; hash de las 18 históricas `2c004078…`. Estas cifras **no se han vuelto a verificar en VPS para este handoff** y no deben presentarse como estado actual. El mock conservaba dos llamadas en memoria (`connected`/`offered`) aun cuando PostgreSQL las consideraba cerradas. Esa deriva debe documentarse antes de nuevas pruebas; no reiniciar servicios para corregirla sin autorización.

### Escenarios CALL-03B2.3 completados (no equivalen a tráfico Meta real)

| Prueba | Resultado reportado | Advertencia |
|---|---|---|
| BIC atendida | `started_at` y `ended_at`; duración 9 s | WebRTC/Firefox mock, no Meta real |
| UIC atendida | Inicio/fin correctos; duración 10 s | Mock sin `ACCEPTED` sintético |
| BIC sin `duration` | Duración derivada 8 s | `terminate` firmado enviado manualmente, no generado por mock |
| UIC rechazada | `rejected`; `duration_seconds=NULL` | Atribución QA agente C |
| UIC no atendida | Expiración aplicación en ~60 s; duración NULL | No probó webhook real de Meta |

## 2. Estructura de PR, sin merges

Orden de integración: **#134 → #136 → #137 → #138 → #140 → #142 → #143 → #144**.
- #141 permanece Draft exclusivamente para el simulador QA: **no integrarlo a producción**.
- #142, #143 y #144 están Draft; el estado de CI no convierte automáticamente un PR en aprobable.
- #144 se basa en la rama de #143. No hacer merge directo de #144 a `main` ni alterar bases sin una revisión de dependencias.
- `main`, VPS QA, Supabase Cloud y producción no fueron modificados durante el desarrollo GitHub de #143/#144.

Referencias:
- [#142](https://github.com/AlexisCasas/wacrm/pull/142) y [#143](https://github.com/AlexisCasas/wacrm/pull/143).
- [#144](https://github.com/AlexisCasas/wacrm/pull/144); [CI](https://github.com/AlexisCasas/wacrm/actions/runs/44919411327); [Migrations](https://github.com/AlexisCasas/wacrm/actions/runs/44919411348).
- Contrato de reserva: [CALL-03B2.5](WHATSAPP_CALLING_CALL03B2_5_TERMINAL_RESERVATION.md).

## 3. Nuevo contrato de seguridad CALL-03B2.5

La migración **`supabase/migrations/20261201000000_whatsapp_call_terminal_reservation.sql`** es un archivo versionado en GitHub; **NO está aplicada por este trabajo en QA ni producción**.

La RPC `whatsapp_call_terminal_reserve` bloquea la fila de llamada y graba `terminal_request_id`, acción, actor, estado y timestamps **antes** del POST a Meta. `claim`, `release` y escritura de SDP quedan bloqueados mientras exista reserva. Solo `service_role` ejecuta las RPC nuevas; cuentan con SECURITY INVOKER. `whatsapp_call_terminal_finish` marca `acknowledged` o `unknown` sin eliminar reserva. Otro intento devuelve 409 (`in_progress`) y **no reenvía Meta**. Si el resultado Meta es incierto, HTTP 202 **no es éxito**; la reserva continúa.

Para abortar una UIC en negociación, la ruta requiere el `claimed_at` original (`claim_epoch`) y la identidad derivada de la sesión. PostgreSQL los comprueba bajo lock para evitar una finalización tardía cuando otro agente ya reclamó. Dos pestañas del mismo usuario **no tienen todavía token UUID por operación**: registrar como riesgo residual.

## 4. Preflight VPS solicitado — SOLO LECTURA

Identificar la misma VPS `srv1917080`, sin asumir que los IDs, imágenes, sesiones y memoria continúan iguales.

| Gate | Qué se necesita verificar | No-go |
|---|---|---|
| HOST-01 | hostname, fecha UTC, `MemAvailable`, disco libre, presión/oom, uso Docker | `MemAvailable < 2560 MiB` o host inestable; no build/despliegue |
| QA-01 | `/opt/apps/call03b2-qa-stack`, Compose servicios esperados; estado/health/uptime/restarts de 7 contenedores y puertos 127.0.0.1:38089/38090 | Servicios QA indisponibles o puertos expuestos públicamente |
| QA-02 | imagen/digest/commit de app, mock, proxy; aislamiento Graph `graph.facebook.com→127.0.0.1`; no acceso real Meta | Llamadas reales posibles o proxy no aislado |
| DB-01 | verificar por SELECT que es **solo DB QA**, versión PostgreSQL, 23 sesiones esperadas como corte histórico, activas, claims/SDP, integridad de 18 históricas | Identidad de base dudosa o anomalías sin explicar |
| DB-02 | funciones instaladas y columnas: 00004 presente; reserva 20261201000000 **aún ausente**; ACL actuales | Nueva migración ya presente de forma no autorizada, drift o incompatibilidad |
| BKP-01 | inventario de dump/sha256 anteriores y capacidad de backup/restore **sin ejecutar nuevo dump** | No existe ruta de recuperación verificable |
| PROD-01 | ID/digest/health/restarts de `wacrm-app-1`, sin consultar payloads privados ni reiniciar | Producción inestable o identidad no verificable |
| EVID-01 | existencia/permisos/índice de evidencias sanitizadas CALL-03B2.3; composición de datos sintéticos | Evidencia perdida o con secretos |

**No publicar** contraseñas, JWT, SDP, tokens de Meta, correos, teléfonos de clientes ni `.env`. Hashes y conteos sí. No emitir SQL que actualice datos en esta fase.

## 5. Secuencia de QA posterior (REQUIERE AUTORIZACIÓN DE ESCRITURA)

1. Evaluar la respuesta del preflight: si cualquier gate crítico falla, **STOP**. Confirmar recursos/aislamiento y un plan de rollback.
2. Crear respaldo nuevo y **verificar restaurabilidad** de PostgreSQL QA, Compose e imágenes; registrar sha256, fecha y ubicación. Hacer esto **solo tras autorización**.
3. Aplicar exclusivamente la migración `20261201000000` a la **BD QA**; verificar columnas, funciones y ACL. Mantener migraciones históricas y datos intactos.
4. Desplegar solo candidato QA de #144 en los servicios estrictamente requeridos; no tocar DB/Auth/Rest/GW salvo cambio aprobado. Evitar builds en la VPS si la memoria cae bajo el umbral.
5. Ejecutar HTTP/HMAC/Graph mock gates y pruebas funcionales Firefox con identidades sintéticas A/C aisladas.
6. Auditar PostgreSQL (reservas, claims, SDP, agentes, eventos, `duration_seconds`, tenant) y comprobar que las 18 históricas no fueron alteradas.
7. Si hay fallo: detener nuevas pruebas, documentar, **no realizar rollback destructivo automático**. La restauración de QA requiere aprobación y procedimiento verificado.

## 6. Matriz de aceptación QA pendiente

| Caso | Escenario | Aceptación mínima |
|---|---|---|
| T-01 | A reclama, suelta; B reclama; A intenta `terminate` tardío | Rechazo 409, **0 POST Meta** del agente A; B conserva claim |
| T-02 | Dos transacciones: reserva de cierre vs claim simultáneo | Exactamente una gana; la otra recibe `denied`/`false`; sin dos owners |
| T-03 | Rechazo UIC y claim concurrente | Un solo efecto; no queda UIC reclamada si se reservó rechazo |
| T-04 | Doble `terminate` y repetición HTTP | Solo el primer `reserved` puede iniciar POST Meta |
| T-05 | Timeout/5xx/resultado de Meta incierto | `terminal_status=unknown`; sin retry; UI no declara cierre confirmado |
| T-06 | Meta confirma terminación/rechazo | `acknowledged`; atribución consistente; ningún reenvío |
| T-07 | `accept` ya en tránsito cuando llega `terminate` | **Gate de seguridad específico**: determinar si se requieren reservas/serialización también para `accept` y `pre_accept`; no declarar PASS solo por T-01 |
| T-08 | Denegación/tardanza del micrófono, cambio de conversación y desmontaje | 0 SDP/claims huérfanos, tracks cerrados, sin terminar llamada ajena |
| T-09 | Dos navegadores A/C, distintos agentes y cuentas | El perdedor: 0 `getUserMedia`; tenant aislado; un único ganador |
| T-10 | Dos pestañas del mismo agente | **Riesgo conocido**: no declarar aislamiento por pestaña hasta token de claim por operación |
| T-11 | Regresión BIC/UIC atendida, rechazada, no atendida | Historial, duración y atribución preservados; Meta real sigue desactivado |

### Restricciones de la prueba

- Usar **solo** Graph mock QA y agentes/cuentas/contactos sintéticos.
- No habilitar webhook real `calls`, ni permisos Meta ni contacto con clientes.
- Guardar únicamente evidencias sanitizadas, sin SDP, credenciales, números de cliente ni secretos.
- El éxito de CI sobre Postgres limpio **no** demuestra que la BD QA esté migrada ni que Firefox real haya pasado.

## 7. Riesgos abiertos y decisión

1. **Carrera `accept` vs `terminate`**: `pre_accept`/`accept` envían side effects a Meta. La reserva de cierre bloquea nuevas escrituras, pero una solicitud Graph ya iniciada puede resolverse después. Se necesita prueba y, si procede, otro gate de señalización atómico.
2. **Mismo usuario en dos pestañas**: no existe token exclusivo de claim por dispositivo/operación.
3. **Conciliación de `unknown`/reservas antiguas**: no hay desbloqueo automático (correcto por seguridad); hace falta procedimiento operativo con evidencia Meta, evitando doble envío.
4. **Meta real**: status ACCEPTED, campos de `terminate`, llamadas no atendidas y suscripción `calls` siguen sin homologación.
5. **Drift histórico**: la evidencia de la VPS y los hashes son resultados reportados, no nuevamente verificados desde esta sesión.

**Estado resultante:** CALL-03B2.5 código y CI PASS; **QA isolated PRECHECK = PENDIENTE**; **merge = NO-GO**; **producción/Meta = NO-GO**.