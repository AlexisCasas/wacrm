# CALL-03B1 — Señalización segura y ciclo de vida Meta

**Estado:** diseño técnico aprobado para implementación en rama.  
**Base:** CALL-03A PR #137, HEAD `57677d395365e11570616cda37bb2b4a19caafe3`; CI #274 y Migrations #168 PASS.  
**Piloto previsto:** solo Keyler, Phone Number ID `740434745820831`.

## 1. Guardas operativas

- Meta `calls` permanece desactivado; `messages` continúa activado.
- No se ejecutan llamadas reales ni se usa el micrófono en CI.
- No se cambian VPS, Supabase Cloud, secretos, variables de entorno ni configuración Meta.
- Toda señalización queda fail-closed por defecto: requiere `WHATSAPP_CALLING_ENABLED=true` y que el `phone_number_id` autenticado esté incluido en `WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS`. El piloto queda limitado al WABA de Keyler; sus contactos siguen siendo los destinatarios de las llamadas.
- Sin allowlist/flag, ninguna ruta puede enviar `connect`, `pre_accept`, `accept`, `reject` o `terminate`.
- No se habilita WebRTC ni se despliega a Vercel producción en esta fase.

## 2. Contrato oficial de Meta

### Llamada entrante (USER_INITIATED)

1. El webhook `calls` entrega `connect` con SDP offer.
2. Un agente obtiene el claim atómico antes de aceptar.
3. El navegador genera un único SDP answer y completa la recolección ICE.
4. WACRM envía `pre_accept` con ese answer.
5. Solo después de que el PeerConnection esté establecido, WACRM envía `accept` usando exactamente el mismo SDP answer.
6. El navegador no habilita el micrófono ni reproduce audio remoto hasta recibir HTTP 200 de `accept`.
7. Rechazo o finalización ejecuta la acción Meta correspondiente y registra el agente.

Meta recomienda `pre_accept` para preparar la conexión; el límite de respuesta de la llamada entrante es de aproximadamente 30–60 segundos.

### Llamada saliente (BUSINESS_INITIATED)

1. El navegador genera un SDP offer.
2. El servidor vuelve a consultar el permiso/cuotas autoritativos de Meta y exige `start_call=true` y permiso temporal vigente o permanente.
3. El servidor envía `connect` con el SDP offer y `biz_opaque_callback_data`.
4. Meta devuelve el `call_id`; el webhook `calls` entrega el SDP answer.
5. El navegador aplica el answer y espera conectividad ICE antes de habilitar audio.
6. La sesión queda vinculada a la conversación y al agente iniciador.

**Importante:** `biz_opaque_callback_data` vuelve en webhooks de estado/finalización; no se usa como correlación del webhook inicial `connect`. La correlación principal de la sesión es el `call_id` que devuelve `connect`.

### Cierre

La acción `terminate` debe enviarse explícitamente incluso cuando WebRTC/RTCP haya terminado el flujo de medios; no se confía únicamente en un BYE local.

## 3. Diseño de servidor

- Añadir almacenamiento cifrado separado para el SDP local del agente (`agent_sdp_encrypted`, tipo y expiración). El SDP remoto recibido de Meta permanece en el campo CALL-02 existente.
- Para UIC, guardar el SDP answer cifrado después de `pre_accept`; `accept` reutiliza el valor almacenado, nunca un SDP distinto enviado por el cliente.
- Para BIC, reservar el intento y el SDP offer cifrado (TTL de cinco minutos) en base de datos antes de llamar a Meta. La misma `request_id` devuelve el intento existente; no vuelve a enviar un `connect`.
- Al recibir `call_id`, crear/actualizar la sesión y guardar conversación, contacto, agente iniciador, callback data y SDP offer cifrado. El upsert tolera que el webhook cree la sesión antes que la respuesta HTTP.
- Meta no devuelve `biz_opaque_callback_data` en el webhook inicial `connect`; los estados/finalización posteriores pueden devolverlo. Ese callback reconcilia un intento `pending/unknown` con su `call_id` y vincula los metadatos y SDP reservados.
- Si la respuesta HTTP se pierde y aún no llega un estado con callback data, el intento queda `unknown` y se bloquea el reenvío automático. La revisión de historial/reconciliación manual es necesaria; no se asume que un timeout significa que Meta no creó la llamada.
- Añadir un RPC para incorporar `biz_opaque_callback_data` de los webhooks posteriores sin modificar la firma histórica de `whatsapp_call_event_apply`.
- GET detalle entrega SDP remoto solo al agente con claim vigente (UIC) o al agente iniciador autenticado (BIC), siempre con TTL válido.
- Las acciones Meta se ejecutan solo en servidor; token y SDP nunca aparecen en logs ni errores públicos.

## 4. Diseño de cliente WebRTC (siguiente subincremento CALL-03B2)

- `getUserMedia({ audio: true, video: false })` únicamente tras click explícito.
- Un solo transceiver de audio; preferir Opus 48 kHz sin reescribir SDP manualmente.
- Esperar ICE gathering completo antes de enviar el SDP para mantener idéntico el answer de `pre_accept` y `accept`.
- Mantener micrófono deshabilitado y audio remoto silenciado hasta confirmación de `accept` HTTP 200.
- Liberar tracks, PeerConnection, listeners y timers en todos los caminos de cierre.
- Configuración ICE inyectable. No hardcodear credenciales TURN ni introducir un proveedor externo sin decisión explícita; sin TURN configurado la conectividad detrás de NAT puede ser limitada y debe quedar como riesgo de QA.

## 5. QA automatizado

- Flag/allowlist ausente, apagado o número no autorizado: 403/409 y cero llamadas a Meta.
- Permiso ausente, vencido o cuota agotada: bloqueo de `connect`.
- Outbound request idempotente: doble envío no produce dos llamadas.
- Respuesta HTTP perdida: estado `unknown`, sin reenvío automático; callback de status/terminate reconcilia `call_id` y metadatos.
- Webhook que llega antes de la respuesta HTTP: upsert converge en una sola sesión.
- UIC: `pre_accept` y `accept` envían exactamente el mismo answer almacenado.
- SDP remoto/local cifrado, TTL vencido, no exposición en listados ni logs.
- Claim de otro agente, tenant cruzado, callback data y evento terminal fuera de orden.
- Rechazo/terminación liberan recursos y quedan atribuidos al agente correcto.
- Graph API completamente mockeada; ningún test llama a Meta.
- Lint, Typecheck, Vitest, Build y replay limpio de migraciones.

## 6. Dependencias y gates

| Gate | Condición |
|---|---|
| B1 | Migración de SDP local/solicitud saliente y RPC idempotentes |
| B2 | API autenticada de señalización y permisos Meta con allowlist fail-closed |
| B3 | Pruebas API/SQL y webhook sintético firmado PASS |
| B4 | Cliente WebRTC browser-only y pruebas con mocks |
| B5 | QA de navegador sin llamadas reales; revisión del PR |
| B6 | CALL-04: activación autorizada de `calls`, despliegue controlado y piloto Keyler |

## 7. Referencias oficiales

- Meta — WhatsApp Calling API: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/
- Meta — User-initiated calls: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls
- Meta — Business-initiated calls: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls

**Resultado esperado de CALL-03B1:** señalización backend segura, idempotente y verificable en CI; sin llamada real, sin activar webhook y sin tocar infraestructura productiva.
