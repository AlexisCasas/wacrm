# CALL-03B2 — Cliente WebRTC e Inbox

**Estado:** diseño y ejecución en rama; no habilita llamadas reales.
**Base apilada:** CALL-03B1 PR #138, HEAD `7eb40d59ee7ed2f7c8edb851b7e67ee8a4fd9b96`.
**Piloto previsto:** Keyler, con feature flag y allowlists de servidor apagados en producción.

## 1. Objetivo

Incorporar al Inbox un cliente WebRTC de audio para llamadas entrantes y salientes de WhatsApp Calling. El navegador solo administra medios y SDP; Meta, tokens, permisos, claims y persistencia permanecen en el servidor autenticado de CALL-03B1.

No se activa el webhook `calls`, no se realizan llamadas reales, no se solicitan permisos de micrófono durante carga de página y no se despliega a producción.

## 2. Arquitectura

- Componente aislado `src/components/inbox/calling-panel.tsx`, integrado en el encabezado del hilo activo.
- Hook/módulo de ciclo de vida separado para `RTCPeerConnection`, stream local, audio remoto, polling y cleanup.
- API existente `/api/whatsapp/calls` como único transporte de señalización; no llamar Graph API desde el browser.
- El componente se limita a la conversación seleccionada. Solo presenta llamadas cuyo `conversation_id` coincide con el hilo y cuyo `phone_number_id`/destinatario supera la guardia de servidor.
- El cliente nunca lee ni escribe tablas Supabase directamente para gestionar llamadas.

## 3. Llamada entrante (UIC)

1. Consultar llamadas recientes cada 3 segundos mientras el Inbox está visible y hay conversación activa.
2. Detectar llamada `USER_INITIATED` en estado `offered/ringing` vinculada al hilo actual.
3. Mostrar aviso de llamada entrante con acciones explícitas Aceptar/Rechazar; no abrir micrófono automáticamente.
4. En click Aceptar: solicitar `getUserMedia({ audio: true, video: false })`, crear PeerConnection y deshabilitar inicialmente el track local.
5. Reclamar la llamada con `claim`; recuperar el SDP offer remoto desde GET detalle (requiere claim vigente).
6. Añadir un único transceiver de audio, aplicar el offer, crear answer y esperar ICE gathering completo.
7. Enviar `pre_accept` con el answer. El servidor persiste el SDP cifrado y Meta recibe el mismo answer.
8. Esperar `connectionState=connected` o un límite controlado; enviar `accept` sin SDP para que el servidor reutilice el answer persistido.
9. Solo tras HTTP 200 de `accept`, habilitar el micrófono y reproducir audio remoto.

## 4. Llamada saliente (BIC)

1. El botón Llamar se muestra solo para contacto con identidad WhatsApp utilizable y conversación activa.
2. En click explícito, solicitar micrófono, crear PeerConnection, añadir audio transceiver y mantener el track deshabilitado.
3. Crear offer, esperar ICE gathering completo y enviar `connect` con `contact_id`, `conversation_id`, `request_id` UUID y SDP offer.
4. Usar el `call_id` devuelto; consultar GET detalle hasta recibir SDP answer remoto fresco (o terminar por timeout/error).
5. Aplicar el answer remoto y esperar `connectionState=connected`.
6. Habilitar audio local y remoto solo al confirmar la conectividad de la llamada.

## 5. Controles y estados UI

- Estados: idle, requesting-media, claiming, connecting, incoming, ringing, connected, ending, ended, failed.
- Controles: aceptar, rechazar, silenciar/activar micrófono, finalizar.
- Indicadores: estado, duración local, error accionable sin SDP/token, destinatario.
- No exponer SDP, access token, callback data ni datos de credenciales en UI, logs o analytics.
- No permitir dos PeerConnections simultáneas; bloquear acciones repetidas mientras haya una operación pendiente.

## 6. Seguridad y ciclo de vida

- `getUserMedia` únicamente desde una interacción explícita.
- Audio local `track.enabled=false` hasta que el backend confirme `accept` (UIC) o se aplique el answer y ICE esté conectado (BIC).
- Audio remoto silenciado hasta que el estado de llamada esté confirmado.
- En rechazo, fin, error, cambio de conversación, desmontaje o pérdida de sesión: detener tracks, cerrar PeerConnection, pausar/desconectar audio element, cancelar polling y listeners; enviar `reject/terminate` cuando corresponda.
- Claim/renew/release se ejecutan mediante la API autenticada; un agente no puede aceptar/rechazar llamadas reclamadas por otro.
- No persistir SDP en localStorage, IndexedDB, sessionStorage ni logs.
- Validar HTTPS/secure context; en HTTP local no seguro, mostrar instrucción clara sin fallback inseguro.

## 7. ICE y conectividad

- Configuración ICE inyectable por una interfaz/configuración controlada; no incrustar credenciales TURN en el bundle.
- No introducir proveedor TURN ni credenciales estáticas en esta fase.
- Sin TURN, NAT/firewall puede impedir llamadas entre redes; clasificarlo como limitación explícita del piloto y no confundir fallo ICE con error de permiso Meta.
- No reescribir SDP manualmente ni forzar códecs; permitir negociación nativa y Opus cuando el navegador lo negocie.

## 8. QA

- Unit tests con mocks para estados y ciclo de vida de PeerConnection, MediaStream, MediaStreamTrack y fetch.
- No ejecutar `getUserMedia` en tests, no acceder a micrófono real y no llamar Graph API.
- UIC: claim requerido, answer único idéntico en `pre_accept/accept`, track muteado hasta HTTP 200.
- BIC: request idempotente, answer remoto aplicado, audio bloqueado hasta ICE connected.
- Pruebas de cleanup en unmount, cambio de conversación, reject, terminate, timeout y errores de permisos del navegador.
- Pruebas de aislamiento de conversación/tenant y doble acción; una sola PeerConnection.
- Lint, Typecheck, Vitest, Build y replay limpio de migraciones heredadas.

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
