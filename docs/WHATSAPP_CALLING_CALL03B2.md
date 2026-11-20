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

## 11. Estado actualizado — QA en VPS y llamadas manuales

**Estado:** CALL-03B2 y CALL-03B2.1 desplegados en QA. Las primeras pruebas manuales salientes y entrantes fueron satisfactorias; el cierre formal de CALL-03 permanece condicionado a cuatro pruebas finales.

### Ramas y PRs

| PR | Alcance | HEAD | Gates |
|---|---|---|---|
| #140 | Cliente WebRTC e Inbox | `5f8f9d6b17dddd8aecdf7b9329969f24d7444543` | CI #373 PASS; Migrations #237 PASS |
| #141 | Simulador Graph/peer, solo QA | `62974616cde92e8bb0cb7e232758dd143d79e475` | CI #380 PASS; Migrations #244 PASS |
| #142 | Asociación entrante y lifecycle | `35cac275fa981ac4dc1ac2def1b38ac2c5481d46` | CI #403 PASS; Migrations #267 PASS |

Los tres PR permanecen abiertos como Draft. PR #141 contiene herramientas exclusivas de QA y no debe desplegarse a producción.

### Despliegue QA

- Worktree del mock: `/opt/apps/wacrm-call03b2-qa`.
- Worktree de aplicación: `/opt/apps/wacrm-call03b2-1-qa`.
- Stack: `/opt/apps/call03b2-qa-stack`.
- App QA: `wacrm-app:call03b2-1-8f2d4ec`.
- Mock: `wacrm-call03b2-mock-graph:62974616`.
- WACRM: `http://127.0.0.1:38089`.
- Peer: `http://127.0.0.1:38090/peer`.

PostgreSQL QA, Auth, REST y Gateway permanecieron en marcha. El mock Graph está aislado en el namespace de la app, `graph.facebook.com` resuelve a loopback y los puertos publicados son loopback-only.

### Resultados manuales reportados

- **Saliente:** llamada establecida; voz y sonido de teclado audibles con buena calidad; desconexión completada.
- **Entrante:** la llamada sintética apareció en el Inbox con Aceptar/Rechazar.
- **Aceptación:** el usuario aceptó la llamada y confirmó recepción de audio.
- **Rechazo:** el rechazo finalizó correctamente y el peer confirmó liberación del micrófono.

La comprobación explícita de audio en ambos sentidos y las pruebas de concurrencia/cambio de conversación/ICE/historial siguen pendientes de evidencia formal.

### CALL-03B2.1 y base QA

- Se asocia una llamada entrante con un contacto/conversación existentes dentro de la cuenta correcta.
- BSUID y parent BSUID se soportan; las identidades ambiguas y los cruces de tenant fallan de forma segura.
- Ofertas entrantes reciben TTL de 60 segundos; ofertas antiguas sin SDP/expiry metadata se terminan después de cinco minutos.
- La migración `20261130000003_whatsapp_calling_inbound_association_lifecycle.sql` está aplicada en `call03b2-qa-db`.
- La función `whatsapp_call_sdp_prune(integer)` se actualizó desde el commit #142. `whatsapp_call_sdp_prune(100)` devolvió `0`.
- La actualización de la función no modificó ninguna de las ocho sesiones existentes. Las tres llamadas históricas ya habían sido terminadas antes de esa operación.
- QA no tiene tabla `supabase_migrations.schema_migrations`; las migraciones históricas fueron aplicadas manualmente y no se creó un historial artificial.

### Seguridad y producción

- Webhook real de Meta `calls`: desactivado.
- Tráfico real hacia Meta: bloqueado por la resolución loopback del mock.
- Secretos del simulador: solo en `.env` QA, fuera de Git.
- Producción: sin cambios; `wacrm-app-1` se mantuvo healthy, sin reinicios ni cambio de imagen.

### Pruebas finales pendientes

1. Concurrencia de dos agentes A/B intentando aceptar la misma llamada.
2. Cambio de conversación mientras una llamada entrante está pendiente.
3. Desconexión ICE persistente y recuperación transitoria dentro de ocho segundos.
4. Historial y atribución por agente. La punta actual de PR #142 añade presentación de agente, fecha y duración con nombres resueltos dentro de la misma cuenta; CI y QA manual T4 pendientes.

El runbook y los criterios de aceptación están en `docs/WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md`.

**CALL-04 no comienza hasta que estas cuatro pruebas estén cerradas.** La activación real del webhook `calls`, flags de producción y piloto real requieren diseño separado y autorización operativa explícita.
