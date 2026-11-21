# CALL-03B2 — Cliente WebRTC e Inbox

**Estado:** implementación en rama; no habilita llamadas reales.
**Base apilada:** CALL-03B1 PR #138, HEAD `7eb40d59ee7ed2f7c8edb851b7e67ee8a4fd9b96`.
**Piloto previsto:** Keyler, con feature flag y allowlists de servidor apagados en producción.

## 1. Objetivo

Incorporar al Inbox un cliente WebRTC de audio para llamadas entrantes y salientes de WhatsApp Calling. El navegador solo administra medios y SDP; Meta, tokens, permisos, claims y persistencia permanecen en el servidor autenticado de CALL-03B1.

No se activa el webhook `calls`, no se realizan llamadas reales, no se solicitan permisos de micrófono durante carga de página y no se despliega a producción.

## 2. Arquitectura

- Componente aislado `src/components/inbox/calling-panel.tsx`, integrado en el encabezado del hilo activo. El primer alcance detecta llamadas entrantes solo para la conversación actualmente abierta; la notificación global del Inbox queda como ampliación posterior.
- Ciclo de vida de `RTCPeerConnection`, stream local, audio remoto, polling y cleanup encapsulado en `CallingPanel`.
- API existente `/api/whatsapp/calls` como único transporte de señalización; no llamar Graph API desde el browser.
- El componente se limita a la conversación seleccionada. Solo presenta llamadas cuyo `conversation_id` coincide con el hilo y cuyo `phone_number_id`/destinatario supera la guardia de servidor.
- El cliente nunca lee ni escribe tablas Supabase directamente para gestionar llamadas.

## 3. Llamada entrante (UIC)

1. Consultar llamadas recientes cada 2.5 segundos mientras el Inbox está visible y hay conversación activa.
2. Detectar llamada `USER_INITIATED` en estado `offered/ringing` vinculada al hilo actual.
3. Mostrar aviso de llamada entrante con acciones explícitas Aceptar/Rechazar; no abrir micrófono automáticamente.
4. En click Aceptar: solicitar `getUserMedia({ audio: true, video: false })`, crear PeerConnection y deshabilitar inicialmente el track local.
5. Reclamar la llamada con `claim`; recuperar el SDP offer remoto desde GET detalle (requiere claim vigente).
6. Añadir un único transceiver de audio, aplicar el offer, crear answer y esperar ICE gathering completo.
7. Enviar `pre_accept` con el answer. El servidor persiste el SDP cifrado y Meta recibe el mismo answer.
8. Esperar `connectionState=connected` o un límite controlado; enviar `accept` sin SDP para que el servidor reutilice el answer persistido.
9. Solo tras HTTP 200 de `accept` con `agent_attribution_recorded=true` (o `already_accepted=true`), habilitar el micrófono y reproducir audio remoto. Si la aceptación no queda atribuida, finalizar la llamada y mantener el audio bloqueado.

## 4. Llamada saliente (BIC)

1. El botón Llamar se muestra solo para el contacto piloto Keyler (`+51 980 942 247`), con conversación activa y permiso de llamadas vigente. La interfaz consulta y muestra el estado de consentimiento; si falta, permite solicitarlo mediante una acción explícita.
2. En click explícito, solicitar micrófono, crear PeerConnection, añadir audio transceiver y mantener el track deshabilitado.
3. Crear offer, esperar ICE gathering completo y enviar `connect` con `contact_id`, `conversation_id`, `request_id` UUID y SDP offer.
4. Usar el `call_id` devuelto; consultar GET detalle hasta recibir SDP answer remoto fresco (o terminar por timeout/error).
5. Aplicar el answer remoto y esperar `connectionState=connected`.
6. Habilitar audio local y remoto solo al confirmar la conectividad de la llamada.

## 5. Controles y estados UI

- Estados: idle, requesting-media, claiming, connecting, incoming, ringing, connected, ending, ended, failed.
- Controles: solicitar consentimiento, aceptar, rechazar, silenciar/activar micrófono y finalizar.
- Historial reciente de llamadas por conversación, con dirección y estado.
- Identidad del agente que atiende visible durante la llamada; el backend conserva la atribución por usuario para auditoría.
- Indicadores: estado, duración local, error accionable sin SDP/token, destinatario.
- No exponer SDP, access token, callback data ni datos de credenciales en UI, logs o analytics.
- No permitir dos PeerConnections simultáneas; bloquear acciones repetidas mientras haya una operación pendiente.

## 6. Seguridad y ciclo de vida

- `getUserMedia` únicamente desde una interacción explícita.
- Audio local `track.enabled=false` hasta que el backend confirme `accept` (UIC) o se aplique el answer y ICE esté conectado (BIC).
- Audio remoto silenciado hasta que el estado de llamada esté confirmado.
- En rechazo, fin, error, cambio de conversación, desmontaje o pérdida de sesión: detener tracks, cerrar PeerConnection, pausar/desconectar audio element, cancelar polling y listeners; enviar `reject/terminate` cuando corresponda.
- Un estado ICE `disconnected` conserva una ventana de recuperación automática de 8 segundos; si vuelve a `connected`, la llamada continúa. Si llega a `failed` o no recupera dentro de la ventana, se envía `terminate` y se liberan los medios.
- Claim/renew/release se ejecutan mediante la API autenticada; un agente no puede aceptar/rechazar llamadas reclamadas por otro.
- No persistir SDP en localStorage, IndexedDB, sessionStorage ni logs.
- El elemento de audio remoto permanece muteado hasta confirmar `accept` (UIC) o conectividad ICE (BIC).
- Validar HTTPS/secure context; en HTTP local no seguro, mostrar instrucción clara sin fallback inseguro.

## 7. ICE y conectividad

- Configuración ICE opcional mediante `NEXT_PUBLIC_WHATSAPP_CALLING_STUN_URLS` (solo URLs `stun:` públicas). No incrustar credenciales TURN en el bundle.
- No introducir proveedor TURN ni credenciales estáticas en esta fase.
- Sin TURN, NAT/firewall puede impedir llamadas entre redes; clasificarlo como limitación explícita del piloto y no confundir fallo ICE con error de permiso Meta.
- No reescribir SDP manualmente ni forzar códecs; permitir negociación nativa y Opus cuando el navegador lo negocie.

## 8. QA

- Unit tests con mocks para estados y ciclo de vida de PeerConnection, MediaStream, MediaStreamTrack y fetch.
- No ejecutar `getUserMedia` en tests, no acceder a micrófono real y no llamar Graph API.
- UIC: claim requerido, answer único idéntico en `pre_accept/accept`, track muteado hasta HTTP 200.
- BIC: request idempotente, answer remoto aplicado, audio bloqueado hasta ICE connected.
- Pruebas de cleanup en unmount, cambio de conversación, reject, terminate, timeout y errores de permisos del navegador.
- Pruebas de permiso/consentimiento, atribución de aceptación, claim concurrente por dos agentes, rechazo, fallo de micrófono y desconexión WebRTC.
- Migración correctiva `20261130000002_whatsapp_call_claim_no_reclaim_after_accept.sql`: un lease vencido no permite que otro agente reclame una llamada ya aceptada.
- Pruebas de aislamiento de conversación/tenant y doble acción; una sola PeerConnection.
- Lint, Typecheck, Vitest, Build y replay limpio de migraciones heredadas, incluyendo el nuevo guard de claim.

## 9. Gates y fuera de alcance

| Gate | Criterio |
|---|---|
| B2-A | Cliente WebRTC aislado y tipado |
| B2-B | UI Inbox entrante/saliente con controles y estados |
| B2-C | Cleanup completo y manejo de permisos/errores |
| B2-D | QA mockeado, CI y build PASS |
| B2-E | Revisión de seguridad y UX; sin activar webhook |
| CALL-04 | Autorización separada para habilitar `calls` y piloto controlado |

Fuera de alcance: habilitar Meta `calls`, cambiar variables/secretos, desplegar Vercel/VPS, ejecutar llamadas reales, añadir TURN externo, grabación de llamadas, videollamadas o persistencia de audio.

**Criterio de cierre:** el Inbox puede completar los flujos en navegador simulado/mock, y todos los recursos de medios se liberan en cualquier salida. El piloto real requiere CALL-04 y autorización explícita.


## 10. Estado de cierre técnico — 20/nov/2026

> **Nota histórica:** el pendiente de QA visual en Vercel descrito en esta sección fue superado mediante QA de navegador en la VPS aislada `call03b2-qa`. No se creó proyecto Vercel. El resultado final está en la sección 11 y en `docs/WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md`.

> **Nota histórica:** este corte fue anterior al despliegue del simulador en la VPS QA y a las pruebas manuales de navegador descritas en la sección 11. El estado vigente está en la sección 11 y en `docs/WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md`.

**Implementación y QA automatizado:** PASS en el código CALL-03B2.  
**QA visual de navegador:** PENDIENTE por falta de un proyecto Vercel enlazado al repositorio WACRM. No se creó proyecto ni deployment.

### HEAD y ejecuciones

- HEAD de código validado: `8282198ea7230e22ea7c80fcc8c13647e97b76d6`.
- CI #371 / run `44767589551`: PASS — Lint, Typecheck, Tests y Build.
- Migrations #235 / run `44767589301`: PASS — replay limpio, esquema, aislamiento multi-tenant, concurrencia, atribución, CALL-03B, RLS y webhook durable.
- `src/components/inbox/calling-panel.test.tsx`: 17 pruebas de regresión.

### Correcciones incorporadas durante la revisión

- Si `terminate` falla, la llamada no desaparece de la interfaz: se conserva el identificador y se permite reintentar.
- Si la configuración saliente falla después de crear la sesión y Meta no confirma la terminación, se detienen los medios locales pero se conserva el control de finalización.
- Si falla la terminación durante un cambio de conversación, se liberan los medios y se mantienen los controles de reintento.
- Se cubren desmontaje, cambio de conversación, desconexión ICE recuperable/fallida, rechazo, permiso de micrófono denegado, claim ocupado y falta de atribución.
- El cliente usa la capacidad `send-messages`, alineada con el guard `requireRole('agent')` del endpoint, para ocultar Calling a usuarios de solo lectura.
- El encabezado del Inbox permite envolver controles en pantallas estrechas y anuncia la llamada entrante con `role="alert"`.

### Alcance y restricciones

- La llamada entrante se detecta únicamente mientras está abierta la conversación correspondiente. El Call Dock global de la implementación alternativa no fue seleccionado para este incremento.
- El PR alternativo #139 fue cerrado como supersedido, sin merge. El PR seleccionado es #140.
- No se solicita micrófono al cargar el Inbox; los tests no usan micrófono real ni invocan Graph API.
- Meta `calls` continúa desactivado y `messages` activo.
- No se modificaron VPS, Supabase Cloud, secretos, allowlists ni producción.
- No se desplegó en Vercel ni se creó un proyecto para obtener preview.

### Pendientes para el cierre formal

1. Conectar el proyecto WACRM existente en Vercel o autorizar un proyecto exclusivo de preview.
2. Ejecutar QA visual del Inbox en escritorio y móvil con una cuenta/entorno de QA seguro.
3. Integrar los PR apilados en orden: #134 → #136 → #137 → #138 → #140.
4. Mantener CALL-04 separado: habilitación de flags/webhook y pruebas reales requieren autorización operativa explícita.

**Estado:** CALL-03B2 automatizado PASS; cierre formal bloqueado únicamente por QA visual y la integración ordenada de dependencias.

## 11. Estado final — QA de navegador en VPS, 20/nov/2026

**CALL-03 QA sintético: completado con hardening previo al primer piloto real.**

| Prueba | Navegador | BD | Resultado |
|---|---|---|---|
| T1 Concurrencia A/C | PASS; un ganador, el otro 409 | PASS; una sesión, sin claims/SDP huérfanos | PASS, con micrófono solicitado antes del claim perdedor |
| T2 Cambio de conversación | PASS; no hubo POST en el hilo alternativo | PASS; vínculo original preservado | PASS |
| T3A Recuperación ICE | Simulada (4 s); no es pérdida real de red | PASS | PASS simulado |
| T3B Desconexión persistente | PASS; `terminate 200`, PeerConnection cerrada y tracks detenidas | PASS; atribución correcta y cero claims | PASS |
| T4 Historial/atribución | PASS; iniciador, aceptante, rechazante y finalizador coinciden | PASS; 41 eventos/41 claves, cero sesiones duplicadas | PASS con timestamps/duración faltantes y nombres incompletos en dos perfiles QA |

### Despliegue y aislamiento

- App QA: `wacrm-app:call03b2-history-8c4d37b` (ID `d9ff178d1bcb`), código funcional `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7`.
- Mock: `wacrm-call03b2-mock-graph:62974616`.
- Se recrearon únicamente `app`, `mock-graph` y `localproxy` con `--no-deps`; `db`, `auth`, `rest` y `gw` no se tocaron.
- Se conservó `docker-compose.yml.bak-pre-8c4d37b`.
- `graph.facebook.com` resolvió a `127.0.0.1`; el mock fue el único receptor Graph Calling.
- Webhook real `calls` desactivado; no se hicieron llamadas ni mensajes reales.
- QA terminó con cero llamadas activas, cero claims huérfanos, cero SDP pendientes y cero intentos salientes con SDP.
- Producción permaneció intacta: `wacrm-app-1`, imagen `shalom-provider-38ecdc51`, healthy, cero reinicios y `/login` HTTP 200.
- No se fusionaron PRs ni se modificó `main`.

### Hardening previo a CALL-04

1. Reclamar la llamada antes de solicitar micrófono; el agente que pierde el claim no debe recibir un prompt. Revalidar/renovar lease y SDP tras el permiso.
2. Alinear el mock con el contrato Meta de `start_time`, `end_time` y `duration` para llamadas atendidas; validar el payload real capturado. El parser/procesador ya reconoce esos campos. La revisión del código del mock encontró `end_time` incondicional, mientras el informe QA indicó que no se observó; reconciliar la captura con la imagen desplegada.
3. Ejecutar una pérdida/recuperación real de red en QA antes de ampliar a más agentes; T3A fue simulada.
4. Los perfiles QA A/B carecen de `full_name`; no es un fallo de código ni de aislamiento. No se modificaron perfiles existentes.

### Integración

Los PR de CALL-01/02/03 siguen abiertos. Integrar en orden #134 → #136 → #137 → #138 → #140 → #142 y repetir CI/Migrations/replay limpio sobre el resultado integrado. #141 es QA-only y no debe entrar en producción. #139 fue cerrado como supersedido sin merge.

**CALL-04 está diseñado, no implementado.** Ver `docs/WHATSAPP_CALLING_CALL04_DESIGN.md`. La activación de settings Meta, webhook `calls`, flags de producción y llamadas reales requieren autorización operativa separada.

## 12. CALL-03B2.2 — Duración del historial (21/nov/2026)

Se publicaron dos ramas de seguimiento, sin PRs y sin merge:

- App: `fix/whatsapp-calling-call03b2-2-duration-20261121`, commit `4122f3bd78ddc876b5177be564cd4499faeb277d`, basada en el HEAD funcional `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7`.
- Mock QA: `qa/call03b2-mock-duration-20261121`, commit `8dd898c2ab16da88d75d847fd99bd2aee65374ae`, basada en `62974616cde92e8bb0cb7e232758dd143d79e475`.

El parche de app guarda el timestamp de status `ACCEPTED` como fallback de inicio, calcula duración a partir de `started_at`/`ended_at` solo para llamadas terminadas y atendidas, y prioriza la duración explícita de Meta. El mock emite `start_time`, `end_time` y `duration` para llamadas conectadas; rechazadas/no atendidas solo reciben `end_time`.

Claude reportó 4,672 tests PASS (213 omitidos), TypeScript y ESLint sin errores para la app, y 13/13 pruebas del mock. GitHub confirma los commits y ramas; no existen workflows/check-runs para esos commits todavía porque no se abrieron PRs.

**Despliegue QA pendiente de confirmación:** la app estaba compilándose según el último informe. La reconstrucción debe tocar solo `app`, `mock-graph` y `localproxy`; no DB/Auth/REST/Gateway.

**Revisión de precisión temporal pendiente antes de merge:** Meta documenta que el status `ACCEPTED` BIC llega después de que la llamada ya está establecida. El `start_time` explícito de `terminate` debe prevalecer sobre ese fallback. La RPC actual conserva el primer `started_at` mediante `COALESCE`, por lo que hay que corregir esa precedencia y probar eventos duplicados/fuera de orden.

El detalle operativo y las pruebas post-deploy están en `docs/WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md`. H1 (claim antes de micrófono) sigue pendiente y precede a cualquier piloto real.

## 13. CALL-03B2.4 — Claim antes del micrófono (21/nov/2026)

Cierra H1: el agente que pierde la carrera por una llamada entrante **nunca** recibe el diálogo de micrófono. Base `9bc35479175278d60b9cb318b2aaaf060d83eb32`; rama local `feat/whatsapp-calling-call03b2-4-claim-order-20261121`. Sin migraciones ni cambios en `route.ts`, RPC, PostgreSQL, Compose o Meta.

### Flujo de `acceptIncoming`

1. Token de operación (`AcceptOperation`): único dueño del claim, los medios y los temporizadores del intento.
2. Estado `claiming`.
3. `claim`. Un 4xx definitivo (409, 403, 404…) termina sin tocar el micrófono ni liberar nada.
4. Claim confirmado; arranca el heartbeat.
5. `GET` del detalle: valida la oferta SDP y `claim_owned_by_me`.
6. Vigencia: `timeout_mic = min(30 s, expiración_SDP − ahora − 15 s)`. Si es menor de 5 s (o la expiración es desconocida) no se pide micrófono, se libera el claim y se muestra `offerExpiringSoon`.
7. Estado `requesting-media`; un único `getUserMedia` con ese timeout.
8. `renew_claim` inmediatamente después del permiso (un reintento ante error transitorio).
9. Se revalida que la conversación no cambió.
10. `PeerConnection`, 11. negociación WebRTC, 12. `pre_accept`.
13. Espera de conexión (el heartbeat sigue activo).
14. `renew_claim` antes de `accept`.
15. `accept` y confirmación de atribución.

### Heartbeat y lease

El lease del servidor es de 90 s y la oferta SDP entrante vive 60 s desde el webhook. El cliente renueva cada 30 s mientras dura el intento (se detiene al terminar o abortar). Un 409/403/404 equivale a claim perdido. Los fallos transitorios (red, 429, 5xx) solo cuentan como pérdida cuando la última renovación confirmada está a 5 s de caducar.

Rate limit medido: las acciones de claim/renew/release comparten el bucket `calling:<userId>` con `RATE_LIMITS.send` = **60 solicitudes/min** (no 3/min). Un accept completo usa ~7 POST y el heartbeat añade 2/min, por lo que no se separó el bucket ni se modificó `route.ts`. `route.test.ts` fija ese supuesto.

### `abortAccept` (cambio de conversación, desmontaje, claim perdido)

- Marca el token, detiene el heartbeat, rechaza todas las esperas en curso, detiene `PeerConnection` y tracks.
- Claim propio y sin `pre_accept`: `release` (sin `terminate`).
- Tras `pre_accept` y claim propio: `terminate` (cierre seguro).
- Claim perdido: no se libera ni se termina nada (la llamada pertenece a otro agente). Tras un 409 en `pre_accept`/`accept` se lee `claim_owned_by_me`; si no es verificable se asume perdido.
- Un `getUserMedia` que resuelve tarde detiene todos sus tracks de inmediato y no crea `PeerConnection`.
- No hay actualizaciones de estado tras el desmontaje (`unmountedRef`).

### Errores de red en `claim`

No se pide micrófono. Se comprueba por lectura (`claim_owned_by_me`) si el servidor adquirió el claim y solo entonces se libera. Si no puede confirmarse, **el lease de 90 s es la protección residual** (nunca se emite un `release` a ciegas: la RPC permite a owner/admin liberar claims ajenos).

### Riesgos residuales

- Mismo agente en dos pestañas: el claim es idempotente para el mismo usuario y ambas pueden continuar. Requiere un token de claim en servidor (migración) y queda fuera de esta fase.
- La vigencia de la oferta usa el reloj del navegador; el margen de 15 s absorbe desfases de segundos.
- `getUserMedia` no es cancelable: el diálogo puede seguir abierto tras abortar; sus tracks se detienen si se concede.
- Pendiente: validación de navegador en QA (Firefox/Chromium con micrófono falso) antes de cualquier despliegue.
