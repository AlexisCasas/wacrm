# WACRM — CALL-03 QA closeout and CALL-04 entry gates

**Estado consolidado:** CALL-03B2 y CALL-03B2.1 desplegados en QA; las primeras pruebas manuales de llamadas salientes y entrantes fueron satisfactorias. El cierre formal de CALL-03 sigue condicionado a cuatro pruebas finales de navegador y a resolver la brecha de presentación del historial.

## 1. Alcance y límites operativos

- Todo el trabajo de navegador y señalización descrito aquí se realizó contra el stack aislado `call03b2-qa` en la VPS.
- El simulador sustituye Graph Calling y entrega webhooks HMAC al endpoint local de WACRM. No representa una llamada real de Meta.
- `graph.facebook.com` se resuelve a `127.0.0.1` dentro del namespace de la app QA; la conexión hacia Meta permanece bloqueada.
- El webhook real de Meta `calls` permanece desactivado. No se han habilitado llamadas reales ni enviado mensajes a clientes.
- Producción permanece sin cambios: contenedor `wacrm-app-1`, imagen y estado healthy conservados según la verificación operativa de Claude Code.
- Los secretos de mock/HMAC/control son exclusivos de QA y permanecen fuera de Git.

## 2. PRs, ramas y gates verificados

| PR | Alcance | Rama / HEAD | CI | Migrations |
|---|---|---|---|---|
| [#140](https://github.com/AlexisCasas/wacrm/pull/140) | Cliente WebRTC e Inbox CALL-03B2 | `feat/whatsapp-calling-call03b2-webrtc-20261120` / `5f8f9d6b17dddd8aecdf7b9329969f24d7444543` | #373 PASS | #237 PASS |
| [#141](https://github.com/AlexisCasas/wacrm/pull/141) | Simulador Graph y segundo peer WebRTC, exclusivamente QA | `qa/call03b2-webrtc-mock-20261120` / `62974616cde92e8bb0cb7e232758dd143d79e475` | #380 PASS | #244 PASS |
| [#142](https://github.com/AlexisCasas/wacrm/pull/142) | Asociación de llamadas entrantes, expiración y protecciones de claim | `feat/whatsapp-calling-call03b2-1-inbound-association-20261120` / `35cac275fa981ac4dc1ac2def1b38ac2c5481d46` | #403 PASS | #267 PASS |

Los tres PR continúan abiertos como Draft y no están fusionados. #141 contiene herramientas de QA: no debe incorporarse a un artefacto de producción.

## 3. Arquitectura QA desplegada

- Stack: `/opt/apps/call03b2-qa-stack` (Compose project `call03b2-qa`).
- Worktree del simulador: `/opt/apps/wacrm-call03b2-qa`, PR #141.
- Worktree de aplicación: `/opt/apps/wacrm-call03b2-1-qa`, PR #142.
- App: `wacrm-app:call03b2-1-8f2d4ec`.
- Mock: `wacrm-call03b2-mock-graph:62974616`.
- WACRM QA: `http://127.0.0.1:38089`.
- Peer QA: `http://127.0.0.1:38090/peer`.
- Los puertos publicados están limitados a loopback; el acceso desde el equipo de QA se realiza mediante túnel SSH.
- PostgreSQL QA, Auth, REST y Gateway permanecieron activos; el despliegue de la app/mock no recreó la base ni sus volúmenes.

## 4. Implementación funcional consolidada

### CALL-03A / CALL-03B1

- Sesiones, eventos, permisos y señalización de llamadas.
- Atribución de agente iniciador, aceptante, rechazante y finalizador.
- Claims atómicos y lease; controles de tenant/contacto/conversación.
- SDP efímero cifrado y TTL; acciones de señalización ejecutadas desde el servidor.
- `biz_opaque_callback_data` y reconciliación de intentos salientes.

### CALL-03B2

- `CallingPanel` integrado en el Inbox y limitado a la conversación activa.
- WebRTC de audio entrante y saliente, permisos explícitos de micrófono y audio bloqueado hasta confirmar la señalización.
- Cleanup de streams, tracks, PeerConnection, timers y listeners.
- Manejo de rechazo, permisos denegados, claim ocupado, cambio de conversación y estados ICE.
- Historial reciente por conversación.
- 17 pruebas unitarias de `src/components/inbox/calling-panel.test.tsx` en el HEAD revisado.

### CALL-03B2.1

- El webhook `USER_INITIATED/connect` resuelve el contacto por teléfono normalizado, BSUID o parent BSUID dentro de la cuenta asociada al `phone_number_id`.
- Solo enlaza si la identidad es inequívoca; una identidad ambigua o de otro tenant no se asocia.
- Selecciona una conversación existente `open`/`pending`; no crea ni reabre conversaciones.
- Preserva los vínculos en eventos duplicados y terminaciones.
- Oferta entrante con TTL de 60 segundos; oferta antigua sin SDP/expiry metadata se termina tras cinco minutos.
- API y RPC de claim fallan de forma segura ante SDP ausente/vencido; una llamada ya aceptada no vuelve a ser reclamable por otro agente.
- La suite SQL `verify-call03b2-1.sql` cubre teléfono, BSUID, parent BSUID, ambigüedad, aislamiento, idempotencia, terminación y expiración.

## 5. QA manual ya ejecutado

Los siguientes resultados son pruebas manuales reportadas por el usuario en Firefox:

| Flujo | Resultado observado |
|---|---|
| Llamada saliente desde WACRM hacia el peer | PASS: llamada establecida; voz y sonido de teclado audibles con buena calidad; al desconectar, la llamada se apagó. |
| Llamada entrante desde el peer | PASS: el evento apareció en el Inbox y se mostraron Aceptar/Rechazar. |
| Aceptar llamada entrante | PASS: el usuario aceptó la llamada y confirmó recepción de audio. |
| Rechazar llamada entrante | PASS: rechazo completado; el peer registró terminación y liberación del micrófono. |

Estos resultados prueban los recorridos sintéticos. La comprobación explícita de audio en ambos sentidos y las cuatro pruebas finales de abajo siguen pendientes de evidencia formal.

## 6. Base de datos QA y limpieza

- La migración `20261130000003_whatsapp_calling_inbound_association_lifecycle.sql` fue aplicada en `call03b2-qa-db` con `supabase_admin`.
- El entorno QA no dispone de `supabase_migrations.schema_migrations`; las migraciones anteriores también fueron aplicadas fuera de un historial versionado. No se creó un historial ficticio.
- Tres llamadas entrantes históricas se cerraron previamente mediante una operación manual autorizada. No fueron cerradas por el último `prune`.
- La función `public.whatsapp_call_sdp_prune(integer)` se actualizó posteriormente con la definición exacta del commit `35cac275fa981ac4dc1ac2def1b38ac2c5481d46`.
- La actualización se ejecutó en una transacción con bloqueos de tablas; `whatsapp_call_sdp_prune(100)` devolvió `0` y se hizo COMMIT.
- Verificación fila a fila y por hash: las ocho sesiones existentes permanecieron idénticas; `CALL03B2_1_EXISTING_SESSIONS_MODIFIED=0`.
- Hash de definición anterior: `85d93854`; hash de definición nueva: `4fe4235d` (MD5 reportado por la sesión operativa).
- Backup previo disponible bajo `/opt/backups/call03b2-qa/`, con permisos 600 y validación `pg_restore --list`.

## 7. Cuatro pruebas finales de CALL-03

Las pruebas unitarias/SQL relacionadas ya pasan en CI, pero falta cerrar su ejecución integrada en navegador QA y adjuntar evidencia. No marcar como PASS hasta completar cada escenario.

### T1 — Concurrencia real entre agentes A/B

**Objetivo:** una misma llamada entrante no puede ser reclamada ni aceptada por dos agentes.

1. Abrir dos sesiones de navegador independientes con los dos usuarios QA de la misma cuenta.
2. Abrir la misma conversación piloto en ambas sesiones.
3. Preparar el peer sintético y generar una sola llamada entrante.
4. Intentar aceptar desde ambos agentes casi simultáneamente.
5. Verificar que exactamente un agente gana el claim; el otro recibe conflicto/no puede ejecutar `pre_accept` ni `accept`.
6. Verificar una sola sesión, un único `accepted_by_user_id`, sin doble señalización ni doble audio.
7. Finalizar la llamada y comprobar que el ownership y el historial son consistentes.

**Evidencia:** capturas de ambas sesiones, respuestas HTTP sanitizadas, `call_id`, `claimed_by_user_id`, `accepted_by_user_id` y conteo de eventos.

### T2 — Cambio de conversación durante una llamada entrante pendiente

**Objetivo:** la llamada solo se presenta y acepta desde la conversación a la que fue asociada.

1. Abrir la conversación piloto y generar una llamada entrante.
2. Antes de aceptar, cambiar a otra conversación.
3. Verificar que desaparece la alerta y no se ejecutan claim/pre_accept/accept en la conversación equivocada.
4. Volver a la conversación piloto antes de vencer el TTL de 60 segundos.
5. Verificar que la llamada vuelve a mostrarse y puede aceptarse desde el hilo correcto.
6. Confirmar que `conversation_id` no cambia y que la llamada no se asocia al hilo alternativo.

**Evidencia:** capturas de ambas conversaciones, acciones de API y `conversation_id` antes/después.

### T3 — Desconexión inesperada, recuperación ICE y liberación

**Objetivo:** una interrupción transitoria no termina prematuramente la llamada; una pérdida persistente sí termina y libera medios.

1. Establecer una llamada aceptada y confirmar audio en ambos sentidos.
2. Provocar una interrupción transitoria de conectividad menor a ocho segundos y restaurarla; verificar que el estado vuelve a `connected` y no se envía `terminate`.
3. En una segunda llamada, desconectar definitivamente el peer o dejar ICE en `failed`/`disconnected` más de ocho segundos.
4. Verificar que WACRM envía `terminate`, detiene tracks y limpia PeerConnection, audio y timers.
5. Confirmar que el peer muestra terminación y que no queda una sesión activa/reclamación huérfana.

**Nota:** el botón actual `Desconectar peer` cierra la PeerConnection; sirve para la ruta de pérdida persistente. La recuperación transitoria ya tiene prueba unitaria en `calling-panel.test.tsx`; el QA manual debe usar una interrupción recuperable sin cerrar definitivamente el peer.

**Evidencia:** estados ICE/connectionState, marcas de tiempo, acción terminal, estado final en DB y confirmación de tracks liberados.

### T4 — Historial y atribución por agente

**Objetivo:** los eventos visibles y persistidos reflejan quién inició, aceptó, rechazó y finalizó cada llamada.

1. Completar una llamada entrante aceptada y terminada.
2. Completar otra entrante rechazada por un agente.
3. Completar una llamada saliente y terminarla.
4. Comparar historial del Inbox con las filas `whatsapp_call_sessions`.
5. Verificar `initiated_by_user_id`, `accepted_by_user_id`, `rejected_by_user_id`, `ended_by_user_id`, `conversation_id`, `direction`, `state`, `duration_seconds`, `created_at`, `started_at` y `ended_at`.
6. Confirmar que los agentes A/B no heredan atribuciones del otro y que los eventos duplicados no duplican sesiones.

**Corrección de UI incorporada en la punta actual de PR #142 (pendiente de CI/QA):** el GET de historial resuelve nombres de agentes desde `profiles` filtrando por el mismo `account_id`; la UI muestra iniciador, aceptante, rechazante/finalizador, fecha y duración. Se añadieron pruebas de API para aislamiento de nombres por cuenta y prueba de componente para la presentación del historial. T4 debe confirmar esta información en el navegador y contrastarla con PostgreSQL QA.

## 8. Criterio de cierre de CALL-03

CALL-03 solo se cierra cuando:

- T1–T4 tienen evidencia QA manual PASS.
- Audio bidireccional confirmado en llamada entrante y saliente.
- Historial y atribución cumplen el contrato funcional (incluida la brecha de UI identificada).
- CI, Migrations y replay limpio siguen PASS para los commits finales.
- Se revisa el orden de integración de PRs apilados.
- El simulador QA queda fuera de los artefactos de producción.
- Meta `calls` permanece desactivado hasta la autorización específica de CALL-04.

## 9. Entrada a CALL-04 — todavía no iniciar implementación

El diseño de CALL-04 comenzará después del cierre de T1–T4. Sus dependencias iniciales son:

1. CALL-01/02/03 integrados en orden y con historial de PRs limpio.
2. Validación documental del contrato Meta vigente: permisos, webhooks, estados, SDP, límites y requisitos de llamada.
3. App Meta/WhatsApp y número empresarial correctamente habilitados para Calling; permisos/consentimiento verificados.
4. Secretos reales gestionados solo en servidor y separados del mock QA.
5. Webhook `calls` configurado con firma verificada, suscripción correcta, idempotencia y durable inbox.
6. Observabilidad y reconciliación de estados, errores, llamadas huérfanas, expiraciones y eventos fuera de orden.
7. Allowlist de piloto de servidor para Keyler, límites de concurrencia y kill switch.
8. Pruebas de seguridad multi-tenant, rate limiting, claims, roles, privacidad de SDP y no exposición de tokens.
9. Plan de rollback, ventana de activación y criterio de salida del piloto antes de ampliar a otros agentes.

CALL-04 no habilita automáticamente llamadas reales: la activación del webhook y de los flags requiere autorización operativa explícita y un gate de preflight separado.

## 10. Estado actual

**CALL-03B2.1 desplegado y validado en QA.** Las pruebas iniciales entrantes/salientes reportadas por el usuario son satisfactorias. La mejora de historial/atribución está implementada en la punta actual de PR #142, pendiente de CI y despliegue QA. **CALL-03 sigue abierto** por T1–T4 manuales. CALL-04 está pendiente de diseño tras el cierre.

