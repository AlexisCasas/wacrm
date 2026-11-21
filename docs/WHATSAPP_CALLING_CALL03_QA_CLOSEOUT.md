# WACRM — CALL-03 QA closeout and CALL-04 entry gates

**Estado consolidado:** T1–T4 de CALL-03 ya se ejecutaron en la VPS QA. T1, T2, T3B y T4 pasaron en navegador/BD; T3A pasó como simulación. Quedan hardening previo a llamadas reales: claim antes de micrófono, fidelidad del mock para timestamps y prueba real de recuperación de red antes de ampliar el piloto.

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
| [#142](https://github.com/AlexisCasas/wacrm/pull/142) | Asociación de llamadas entrantes, expiración y protecciones de claim | `feat/whatsapp-calling-call03b2-1-inbound-association-20261120` / código funcional `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7` | #419 PASS | #283 PASS |

Los tres PR continúan abiertos como Draft y no están fusionados. #141 contiene herramientas de QA: no debe incorporarse a un artefacto de producción.

## 3. Arquitectura QA desplegada

- Stack: `/opt/apps/call03b2-qa-stack` (Compose project `call03b2-qa`).
- Worktree del simulador: `/opt/apps/wacrm-call03b2-qa`, PR #141.
- Worktree de aplicación: `/opt/apps/wacrm-call03b2-1-qa`, PR #142.
- App actualizada: `wacrm-app:call03b2-history-8c4d37b` (ID `d9ff178d1bcb`).
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
- 18 pruebas unitarias de `src/components/inbox/calling-panel.test.tsx` en el HEAD revisado.

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

## 7. Ejecución final T1–T4 — 20/nov/2026

**Resultado general:** las cuatro pruebas funcionales se ejecutaron en la VPS QA. T1, T2, T3B y T4 pasan con las salvedades registradas abajo. T3A pasa como simulación de estado WebRTC, no como interrupción real de red. Esto cierra la ronda de QA sintética; no equivale a autorización ni validación de llamadas reales de Meta.

| Prueba | Automatizada | Navegador | BD | Resultado |
|---|---|---|---|---|
| T1 Concurrencia A/C | Solo prueba SQL de claim (`verify-concurrency.sh`) | PASS | PASS | **PASS**, con solicitud de micrófono previa al claim del agente perdedor |
| T2 Cambio de conversación | Solo pruebas unitarias (CI) | PASS | PASS | **PASS** |
| T3A Recuperación ICE | Solo pruebas unitarias (CI) | Simulada, no es interrupción real de red | PASS | **PASS simulado** |
| T3B Desconexión persistente | Sin automatización específica | PASS | PASS | **PASS** |
| T4 Historial y atribución | Solo pruebas unitarias (CI) | PASS | PASS | **PASS**, con datos de duración y nombres de QA incompletos |

### T1 — Concurrencia A/C

- A y C abrieron la misma conversación y aceptaron casi simultáneamente una única llamada entrante.
- A obtuvo `claim 200`, `pre_accept 200` y `accept 200`.
- C obtuvo `claim 409`, no estableció audio y liberó su pista de micrófono.
- La BD conservó una sola sesión; `accepted_by_user_id` y `ended_by_user_id` corresponden a A; no quedaron claims ni SDP.
- **Hallazgo de privacidad/UX:** C recibió el prompt de micrófono antes de que el servidor rechazara su claim. No hubo audio para C y la pista fue liberada, pero la solicitud de permiso era evitable. Ver sección 8.

### T2 — Cambio de conversación

- Llamada sintética `…18cc86`.
- Al cambiar al hilo alternativo, la alerta desapareció y no se envió ningún POST a la API.
- Al volver al hilo piloto 10 segundos después, la llamada reapareció y pudo aceptarse y finalizarse.
- `conversation_id` permaneció asociado al hilo piloto.
- Tras comprobar que cero llamadas referenciaban el contacto alternativo, se eliminaron el contacto y su conversación sintéticos.

### T3 — ICE y desconexión

**T3A — recuperación simulada (`…471255`)**

- Se simuló `connectionState=disconnected` durante aproximadamente cuatro segundos y luego se restauró.
- No se envió `terminate`; la llamada siguió activa y el estado final fue `connected`.
- Es una simulación de la API WebRTC, no una pérdida real de paquetes, interfaz de red o conectividad.

**T3B — desconexión persistente (`…bd3a12`, `…e253f1`, `…a6d735`)**

- El botón `Desconectar peer` llevó a `disconnected` aproximadamente a los ocho segundos.
- WACRM envió `terminate` y recibió HTTP 200 aproximadamente a los 16 segundos.
- Cinco segundos después, la `PeerConnection` estaba cerrada y las pistas estaban terminadas.
- La BD registró `ended_by_user_id` del agente activo y no quedaron claims.
- Se observó un estado transitorio `disconnected/live` si se consultaba antes de que respondiera `terminate`; la liberación local y el cierre final se confirmaron después de la respuesta.

### T4 — Historial y atribución

- Se contrastaron llamadas entrantes aceptadas, entrantes rechazadas y salientes, incluyendo tres llamadas realizadas por el agente sintético C.
- La UI coincidió con la BD para dirección, estado y atribución: iniciador, aceptante, rechazante y finalizador se resolvieron desde perfiles de la misma cuenta.
- Se verificaron 41 eventos con 41 claves distintas y cero sesiones duplicadas.
- La UI muestra `Duración: —` en las sesiones donde `duration_seconds` es `NULL`.

## 8. Hallazgos y acciones antes de llamadas reales

### H1 — El claim debe preceder a la solicitud de micrófono

**Severidad:** precondición obligatoria antes del piloto real.

La implementación actual de `CallingPanel.acceptIncoming` solicita `getUserMedia()` antes de ejecutar `POST action=claim`. Por eso el agente perdedor de T1 recibe un prompt de micrófono aunque el servidor después le responda 409.

**Corrección propuesta (no aplicada en este cierre):**

1. Al hacer clic en Aceptar, reclamar la llamada primero.
2. Si el claim devuelve 409, no pedir acceso al micrófono ni crear `MediaStream`/`RTCPeerConnection`.
3. Solo después de ganar el claim solicitar micrófono.
4. Si el usuario deniega/cancela, liberar el claim y detener cualquier pista creada.
5. Tras resolver el prompt, renovar/revalidar el lease y volver a comprobar que la oferta SDP sigue vigente antes de `pre_accept`; la oferta entrante expira a los 60 segundos y el lease actual es de 90 segundos.
6. Añadir prueba que demuestre `getUserMedia` no se invoca cuando claim responde 409 y prueba que la denegación de micrófono libera el claim.

### H2 — Duración y timestamps de Meta

**Severidad:** corregir el simulador y validar el payload antes del piloto; no requiere asumir una migración de esquema.

La documentación oficial de Meta especifica que `start_time`, `end_time` y `duration` solo aparecen en el webhook `terminate` cuando la otra parte atendió la llamada. Una llamada `COMPLETED` no atendida puede carecer legítimamente de los tres campos. `duration` está en segundos.

Revisión del código:

- `calling-webhook.ts` ya parsea `start_time`, `end_time` y `duration`.
- `calling-webhook-processor.ts` ya los transforma en `p_started_at`, `p_ended_at` y `p_duration_seconds` para `whatsapp_call_event_apply`.
- La migración CALL-03B2.1 ya persiste esos parámetros de forma aditiva con `COALESCE`.
- La prueba del processor verifica `duration`, pero todavía no cubre conjuntamente `start_time` y `end_time`.
- En el HEAD de PR #141 (`62974616`), `server.mjs` sí añade `end_time` en el evento `terminate`, pero no añade `start_time` ni `duration`; además lo añade incluso para llamadas no atendidas. Esto no coincide exactamente con el informe de navegador, que indica que no se emitieron los tres campos. Hay que contrastar el payload sanitizado capturado con el código exacto de la imagen desplegada.

**Corrección propuesta (no aplicada):**

1. El mock debe emitir `start_time`, `end_time` y `duration` solo cuando `acceptedAt` exista.
2. Para llamadas no atendidas/rechazadas debe omitir los tres campos.
3. Añadir pruebas de parser, processor y mock para ambas ramas.
4. Reproducir un `terminate` sintético y verificar la persistencia SQL y la UI.
5. En Meta real, no inventar duración ni timestamps si Meta los omite; mantener `NULL` y distinguir llamada no atendida de telemetría pendiente/incompleta.

**No hace falta una nueva migración** salvo que el replay o la inspección del esquema real contradigan el contrato existente.

### H3 — Nombres de A/B en los perfiles QA

Los perfiles de A y B no tienen `full_name`; por eso la UI muestra `Agente no disponible`. C sí tiene nombre y se muestra correctamente. Es un dato incompleto de los perfiles QA, no un fallo del aislamiento multi-tenant ni de la consulta. No se modificaron perfiles existentes.

### H4 — T3A no es una prueba real de pérdida de red

T3A se conserva como PASS simulado. Antes de ampliar el piloto a más agentes/clientes debe ejecutarse una prueba controlada de interrupción de red en un entorno QA, sin manipular la red de producción. T3B sí verificó desconexión persistente y liberación.

## 9. Despliegue QA, limpieza y aislamiento

Según el informe de ejecución de Claude Code:

- Worktree `/opt/apps/wacrm-call03b2-1-qa` actualizado por fast-forward a `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7`, árbol limpio.
- Imagen de app: `wacrm-app:call03b2-history-8c4d37b` (ID `d9ff178d1bcb`).
- Mock: `wacrm-call03b2-mock-graph:62974616`.
- Se recrearon `app`, `mock-graph` y `localproxy` con `--no-deps`.
- Backup del Compose: `docker-compose.yml.bak-pre-8c4d37b`.
- `db`, `auth`, `rest` y `gw` permanecieron intactos; no hubo migraciones ni cambios de esquema.
- A y B pertenecían a cuentas distintas. No se modificaron sus perfiles. Se creó un agente sintético C dentro de la cuenta A para T1; sus credenciales quedaron únicamente en `.env` con permisos 600 y su cuenta automática fue eliminada.
- `graph.facebook.com` continuó resolviendo a `127.0.0.1`; el mock fue el único receptor de Graph Calling.
- Webhook real `calls` desactivado; no hubo llamadas ni mensajes reales.
- Al cierre: cero llamadas activas, cero claims huérfanos, cero SDP pendientes y cero intentos salientes con SDP. Las llamadas de prueba quedaron `terminated` o `rejected`; se conservó un contacto y una conversación QA.
- Se reportaron dos errores de `pricing analytics` contra el mock; no se reportaron otros errores de Calling.
- Producción permaneció sin cambios: `wacrm-app-1`, imagen `shalom-provider-38ecdc51`, healthy, cero reinicios y `/login` HTTP 200.
- No se fusionaron PRs ni se modificó `main`.

**Evidencia QA en VPS:** `/opt/backups/call03b2-qa/evidence/call03-closeout/` contiene 23 capturas sanitizadas, `RESULTS.md`, `sessions-final-sanitized.txt` y scripts de prueba. Hay tres capturas de ejecuciones T3B repetidas.

## 10. Estado de cierre y dependencias de integración

**CALL-03 QA sintético: completado con hallazgos de hardening previos a llamadas reales.** T1, T2, T3B y T4 pasaron en navegador/BD; T3A es PASS simulado. No se habilitó Meta ni se tocó producción.

### PRs y orden de integración

| Orden | PR | Incremento | Estado | Gates del HEAD revisado |
|---:|---|---|---|---|
| 1 | [#134](https://github.com/AlexisCasas/wacrm/pull/134) | CALL-01 | Open, no draft | CI #241 PASS |
| 2 | [#136](https://github.com/AlexisCasas/wacrm/pull/136) | CALL-02 | Open, Draft | CI #252 PASS; Migrations #147 PASS |
| 3 | [#137](https://github.com/AlexisCasas/wacrm/pull/137) | CALL-03A | Open, Draft | CI #294 PASS; Migrations #186 PASS |
| 4 | [#138](https://github.com/AlexisCasas/wacrm/pull/138) | CALL-03B1 | Open, Draft | CI #326 PASS; Migrations #218 PASS |
| 5 | [#140](https://github.com/AlexisCasas/wacrm/pull/140) | CALL-03B2 | Open, Draft | CI #373 PASS; Migrations #237 PASS |
| 6 | [#142](https://github.com/AlexisCasas/wacrm/pull/142) | CALL-03B2.1 + historial | Open, Draft | CI #419 PASS; Migrations #283 PASS |

- PR #141 es el simulador Graph/peer, exclusivo de QA; **no se integra al artefacto de producción**.
- PR #139 fue cerrado sin merge por estar supersedido por #140.
- CALL-01 y CALL-02 aún no están fusionados a `main`. Por tanto, CALL-04 no puede pasar a activación hasta revisar y fusionar el stack en el orden anterior y repetir los gates sobre la rama integrada.

### Gates de salida antes del primer piloto real

1. Corregir H1: claim antes del micrófono y prueba de regresión de claim perdido.
2. Corregir H2: mock `terminate` fiel a Meta y prueba de timestamps/duración en llamadas atendidas y no atendidas.
3. Completar revisión de T3A como prueba real de red en QA antes de ampliar el piloto.
4. Revisar los perfiles del agente piloto para que tengan nombre visible; no cambiar perfiles de otros usuarios.
5. Integrar PRs #134 → #136 → #137 → #138 → #140 → #142 en orden; excluir #141.
6. Repetir CI, Migrations, replay limpio y QA de humo sobre el stack integrado.
7. Mantener el webhook real `calls` y el flag de Calling desactivados hasta una autorización específica de CALL-04.

El diseño de CALL-04 se encuentra en `docs/WHATSAPP_CALLING_CALL04_DESIGN.md`. El diseño no autoriza activar settings de Meta, suscribir el webhook real ni iniciar llamadas reales.


## 11. CALL-03B2.2 — Duración del historial: parches publicados, QA pendiente

**Estado al 21/nov/2026:** los dos commits están publicados en GitHub y sus ramas se verificaron. Claude reportó build de la app en curso y posterior recreación de `app`, `mock-graph` y `localproxy`; el despliegue final aún no está confirmado por esta auditoría de GitHub.

### Ramas y commits verificados

| Componente | Rama | Commit | Base verificada | Cambios |
|---|---|---|---|---|
| Aplicación | `fix/whatsapp-calling-call03b2-2-duration-20261121` | [`4122f3bd78ddc876b5177be564cd4499faeb277d`](https://github.com/AlexisCasas/wacrm/commit/4122f3bd78ddc876b5177be564cd4499faeb277d) | `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7` (1 commit ahead) | 6 archivos: `ACCEPTED` registra inicio provisional; helper de duración; GET lista/detalle calcula duración derivada; pruebas |
| Simulador QA | `qa/call03b2-mock-duration-20261121` | [`8dd898c2ab16da88d75d847fd99bd2aee65374ae`](https://github.com/AlexisCasas/wacrm/commit/8dd898c2ab16da88d75d847fd99bd2aee65374ae) | `62974616cde92e8bb0cb7e232758dd143d79e475` (1 commit ahead) | 2 archivos: `terminate` envía `start_time`, `end_time`, `duration` solo si la llamada se conectó |

Las dos ramas existen en el repositorio remoto. No se abrieron PRs, no se fusionaron cambios y no se modificó `main`.

### Validación local reportada por Claude

- App: 346 archivos de prueba; 4,672 tests PASS, 213 omitidos; `tsc --noEmit` PASS; ESLint sin errores (un warning preexistente en `route.signaling.test.ts:115`).
- Mock: 13/13 pruebas PASS.
- Estos son resultados locales reportados por Claude. Los endpoints de GitHub Actions no muestran workflows ni check-runs para esos dos commits; al no abrir PRs, no hay CI/Migrations PASS atribuible a estos commits.

### Estado del despliegue QA

- Claude reportó que la imagen de la app estaba compilándose y que después construiría el mock y recrearía `app`, `mock-graph` y `localproxy`.
- No hay aún en esta auditoría un tag/ID de imagen final, hora de recreación ni comprobación HTTP posterior. Mantener estado `DEPLOYMENT_PENDING_VERIFICATION` hasta recibir esos datos.
- La recreación autorizada debe limitarse a `app`, `mock-graph` y `localproxy` con `--no-deps`. No recrear `db`, `auth`, `rest`, `gw`; no aplicar migraciones ni tocar volúmenes.
- Mantener `graph.facebook.com -> 127.0.0.1`, certificados del mock, puertos loopback, webhook real `calls` apagado y producción intacta.

### QA funcional requerido después del despliegue

1. Verificar imagen/commit exactos en `app` y mock; contenedores sin reinicios y `/login` HTTP 200.
2. Verificar `POST /api/whatsapp/calls` sin sesión = 401, peer `/qa/health` = 200 y Auth health = 200.
3. Verificar dentro del contenedor que `graph.facebook.com` resuelve a `127.0.0.1`; el mock es el único receptor y no hay salida real a Meta.
4. Ejecutar una llamada BIC sintética conectada, terminarla y verificar `started_at`, `ended_at`, `duration_seconds` y la duración mostrada en el Inbox.
5. Ejecutar una llamada UIC sintética conectada, terminarla y verificar los mismos campos. No asumir que el status `ACCEPTED` se emite para UIC; comprobar el payload real del mock y el contrato específico.
6. Ejecutar una llamada rechazada y otra no atendida: ambas deben conservar duración NULL y no mostrar una duración inventada.
7. Verificar que las 17 sesiones históricas no se modificaron automáticamente; seguirán con duración `—` salvo una migración/backfill explícito que no forma parte de este parche.
8. Cerrar las llamadas sintéticas y verificar cero llamadas activas, claims huérfanos y SDP pendiente.

### Revisión adicional del contrato Meta: precedencia de `started_at`

Hay una sutileza que debe resolverse antes de fusionar el parche de aplicación:

- La documentación oficial de Meta indica que el status `ACCEPTED` para BIC llega **después de que la llamada ya está establecida** y sirve para auditoría. No es necesariamente el instante exacto de inicio del audio.
- El webhook `terminate` proporciona `start_time`, `end_time` y `duration` para llamadas atendidas. `duration` es la fuente preferida para duración; `start_time` del `terminate` debe ser la fuente autoritativa para `started_at` cuando venga presente.
- El parche actual escribe `started_at` desde `ACCEPTED`, mientras la función SQL existente usa `COALESCE(existing.started_at, EXCLUDED.started_at)`. Por tanto, el timestamp provisional de `ACCEPTED` podría impedir que el `start_time` exacto del `terminate` lo reemplace.

**Corrección requerida antes del merge:** ajustar la RPC/contrato de persistencia para que un `start_time` explícito del evento `terminate` prevalezca sobre el timestamp provisional de `ACCEPTED`, respetando el guard de orden temporal e idempotencia. Si Meta no envía `start_time`, el timestamp de `ACCEPTED` puede utilizarse como fallback aproximado, pero no debe presentarse como la hora exacta de inicio. Añadir prueba de ambos eventos y de llegada fuera de orden. Confirmar si el fallback aplica solo a BIC, que es donde Meta documenta el status `ACCEPTED`.

Referencias Meta:

- BIC: `ACCEPTED` llega después de establecerse la llamada: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls
- UIC: el webhook `terminate` muestra `start_time`, `end_time` y `duration`; ventana de aceptación de 30–60 segundos: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls

### Estado de CALL-03 y siguiente trabajo

- H2 (semántica del mock y cálculo de duración): código publicado; despliegue y QA aún pendientes; además queda resolver la precedencia de `started_at` antes de fusionar.
- H1 (claim antes de micrófono): sigue pendiente y es el siguiente parche de aplicación prioritario. El agente que pierde el claim no debe recibir el prompt de micrófono.
- T3A: sigue siendo PASS simulado; la prueba de pérdida/recuperación real de red en QA sigue pendiente antes de ampliar el piloto.
- CALL-04 permanece en diseño. No activar Meta, el webhook real `calls` ni llamadas reales.
