# CALL-03B2 — Inbox, WebRTC y controles de llamada

**Estado:** diseño técnico en rama; implementación pendiente de que CALL-03B1 pase CI y Migrations en su HEAD actual.  
**Base:** `feat/whatsapp-calling-call03b-signaling-20261120` — `f277cbee72b9ea7aabf0687a7b9a132d1a4c6e87`.  
**Piloto:** únicamente el contacto Keyler `+51 980 942 247`, dentro del WABA `740434745820831`.

## 1. Límites operativos

- Meta `calls` continúa desactivado; `messages` continúa activo.
- No habilitar webhooks, flags ni allowlists en producción durante este incremento.
- No ejecutar llamadas reales ni pruebas de micrófono en CI.
- El navegador solicita `getUserMedia({ audio: true, video: false })` solamente después de una acción explícita del agente (Llamar/Aceptar).
- No modificar VPS, Supabase Cloud, secretos, variables productivas ni desplegar.
- No agregar migraciones: las tablas de llamadas mantienen RLS y permisos de servidor. El cliente nunca consulta SDP ni tablas de Calling directamente.
- No introducir proveedor TURN ni credenciales estáticas. La configuración ICE será inyectable; sin TURN/STUN configurado, la conectividad entre NAT/firewalls puede ser limitada y se debe mostrar el estado de conexión.

## 2. Arquitectura

### Componentes propuestos

- `src/hooks/use-whatsapp-calling.ts`: controlador de llamadas, polling, estado WebRTC, permisos, claim, mute y limpieza.
- `src/lib/whatsapp/calling-webrtc.ts`: utilidades WebRTC puras/testeables (validación SDP, ICE gathering con timeout, creación/cierre de PeerConnection y liberación de tracks).
- `src/components/inbox/call-dock.tsx`: banner global de llamada entrante y panel de llamada activa, incluso cuando no está abierta la conversación.
- `src/components/inbox/call-controls.tsx`: botón/diálogo Llamar, estado de permiso y solicitud de permiso desde la cabecera de la conversación.
- `src/components/inbox/call-history.tsx`: historial vinculado a la conversación, con dirección, fecha, duración, resultado y agente.
- Integración en `InboxPage` y `MessageThread`; mantener la lógica de mensajes y suscripciones actuales separadas.

### Detección de llamadas

`whatsapp_call_sessions` tiene RLS y privilegios exclusivos de `service_role`. Por ello el navegador no debe suscribirse directamente a la tabla. El hook consulta el GET autenticado `/api/whatsapp/calls` cada 3–4 segundos mientras la pestaña está visible y vuelve a consultar al recuperar el foco. Las llamadas entrantes elegibles se obtienen del resultado del servidor (`claim_available`); no se confía en filtros del navegador como autorización.

El GET aceptará `conversation_id` opcional para recuperar historial sin descargar llamadas de otras conversaciones.

## 3. Flujos de llamada

### Entrante (UIC)

1. Detectar una llamada `offered/ringing` elegible y mostrarla en el Call Dock.
2. El agente pulsa **Aceptar**; el servidor intenta adquirir el claim de 90 segundos. Si otro agente lo tiene, mostrar conflicto y no acceder al SDP.
3. Después del click, pedir micrófono; obtener el detalle autenticado y leer el SDP offer solo si el claim pertenece al agente y sigue vigente.
4. Crear PeerConnection, aplicar el offer remoto, añadir el track local, crear answer y esperar ICE gathering (con timeout).
5. Enviar `pre_accept` con ese answer y luego `accept`; ambos usan el mismo SDP answer almacenado/cifrado por CALL-03B1.
6. Activar el audio remoto cuando llegue el track y mostrar estado conectado. Renovar el claim mientras la llamada siga bajo control del agente.
7. **Rechazar** usa `reject`; **Finalizar** usa `terminate`. Liberar micrófono, PeerConnection y audio en todos los caminos.

### Saliente (BIC)

1. El agente pulsa **Llamar** desde la conversación.
2. Consultar permiso/cuota Meta. Si no existe permiso vigente, ofrecer `request_permission` y no pedir micrófono ni iniciar señalización.
3. Tras permiso vigente y click explícito en **Iniciar llamada**, pedir micrófono, crear PeerConnection, offer y esperar ICE gathering.
4. Enviar `connect` con `contact_id`, `conversation_id`, `request_id` UUID y SDP offer.
5. Consultar el detalle autenticado hasta recibir el SDP answer remoto de Meta; aplicarlo a la PeerConnection.
6. Mostrar audio/estado. Finalizar mediante `terminate`; nunca repetir `connect` para el mismo resultado ambiguo.

### Desconexión y limpieza

- Estados visibles: `connecting`, `ringing`, `connected`, `reconnecting`, `failed`, `ending`, `ended`.
- Si ICE queda `disconnected`, mantener la PeerConnection durante una ventana de recuperación y observar si vuelve a `connected`; no crear una llamada nueva ni reenviar `connect/accept`.
- Si ICE queda `failed` o vence la ventana, mostrar fallo y permitir finalizar. No inventar renegociación/ICE restart hasta que exista un contrato de señalización soportado por Meta.
- Detener todos los tracks locales, cerrar PeerConnection, retirar listeners/timers y limpiar `audio.srcObject` al terminar, cambiar de sesión o desmontar.
- Si el navegador bloquea autoplay, mostrar control explícito **Activar audio**.

## 4. Interfaz

- Cabecera de conversación: botón de llamada disponible solo para roles con permiso de envío y contactos permitidos por el piloto.
- Diálogo de salida: estado del permiso, solicitar permiso o iniciar llamada; explicar que el micrófono se solicita al iniciar, no al abrir el diálogo.
- Call Dock global: llamada entrante con nombre/número, Aceptar/Rechazar; llamada activa con estado, duración, Silenciar/Activar micrófono y Finalizar.
- Historial por conversación: entrantes/salientes, fecha, duración, estado y agente iniciador/aceptante. Mostrar el nombre de perfil cuando esté disponible; no exponer SDP ni datos opacos.
- Diseño adaptable a móvil/desktop, sin desplazar ni romper el hilo de mensajes, panel lateral o composer existentes.

## 5. Contrato API utilizado

- `GET /api/whatsapp/calls`: detección de llamadas y refresco de estados.
- `GET /api/whatsapp/calls?call_id=...`: detalle y SDP solo para claim activo o iniciador saliente.
- `GET /api/whatsapp/calls?conversation_id=...`: historial de esa conversación (nuevo filtro de lectura).
- `POST claim / renew_claim / release`: propiedad y lease.
- `POST check_permission / request_permission`: consentimiento Meta.
- `POST connect / pre_accept / accept / reject / terminate`: señalización del servidor.
- Nunca llamar Graph API directamente desde el navegador ni guardar tokens/SDP en localStorage, sessionStorage, logs o URL.

## 6. Pruebas y criterios de aceptación

- [ ] Micrófono no solicitado al cargar Inbox, abrir diálogo o consultar permisos; solo tras click explícito.
- [ ] Micrófono denegado/no disponible: mensaje claro, sin llamada creada ni recursos retenidos.
- [ ] UIC: claim concurrente, SDP offer recuperado bajo claim, answer idéntico en `pre_accept/accept`, rechazo y finalización.
- [ ] BIC: permiso faltante bloquea micrófono/connect; permiso vigente produce una sola solicitud idempotente y aplica SDP answer remoto.
- [ ] Audio remoto recibido, mute/unmute local, autoplay bloqueado y botón de habilitar audio.
- [ ] ICE `disconnected/connected/failed`, timeout, cambio de conversación, cierre de diálogo y desmontaje limpian recursos.
- [ ] El historial solo muestra llamadas de la conversación activa y muestra agente/fecha/duración/resultado.
- [ ] Dos agentes no pueden atender la misma llamada; el cliente no puede recuperar SDP ajeno, expirado o terminal.
- [ ] Pruebas unitarias/componentes con mocks de `getUserMedia`, `RTCPeerConnection` y API; cero micrófono o llamadas reales en CI.
- [ ] CI Lint/Typecheck/Tests/Build PASS y revisión del diff. Migrations PASS heredado de CALL-03B1; sin migración nueva.
- [ ] Meta `calls` sigue OFF y no hay despliegue.

**No se considera terminado CALL-03B2 por mostrar botones.** Debe quedar validado el flujo de audio, ownership, permisos, historial y limpieza de recursos. La prueba real de llamada se reserva para un QA controlado posterior con autorización explícita.
