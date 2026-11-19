# WhatsApp Calling en WACRM — plan y CALL-01

**Estado:** desarrollo inicial en rama; no habilitado en producción.  
**Piloto previsto:** cuenta de Keyler Ortega.  
**Número confirmado por el operador:** +51 980 942 247.  
**Phone Number ID confirmado por la captura de Meta:** 740434745820831.

## 1. Objetivo

Incorporar llamadas de voz nativas de WhatsApp Business Calling API dentro del Inbox de WACRM, empezando por una única cuenta piloto y manteniendo la capacidad deshabilitada para el resto de cuentas hasta superar QA y el despliegue controlado.

La solución será multi-tenant desde el diseño: toda sesión y todo evento se asociará al `phone_number_id` de Meta y a la cuenta propietaria de `whatsapp_config`. No se utilizará un identificador global de Keyler en el código.

## 2. Configuración de Meta observada

La captura de WhatsApp Manager para el número de Keyler muestra:

| Ajuste | Estado observado | Decisión |
|---|---|---|
| Permitir llamadas de voz | Activado | Correcto |
| Mostrar botones de llamada | Activado | Correcto |
| Horario de disponibilidad | Sin horario específico configurado | Meta considera el número disponible todo el tiempo |
| Detener temporalmente llamadas entrantes | Sin configuración observada | No configurar en esta fase |
| Permitir devolución de llamadas | Desactivado | Mantener por ahora; afecta la concesión automática de permiso de devolución, no la recepción básica de llamadas |
| SIP | Desactivado | Mantener desactivado; se usará la señalización estándar de Calling API y WebRTC |

La pestaña **Calling limits** todavía debe revisarse antes de las pruebas reales. Que el ajuste de voz aparezca activado no demuestra por sí solo que todos los límites y permisos de la cuenta estén satisfechos.

### Permiso de devolución

Con `callback_permission_status` desactivado, WACRM no debe asumir que una llamada entrante autoriza automáticamente una llamada saliente. Para las llamadas iniciadas por la empresa, CALL-02 deberá comprobar el permiso vigente del cliente y, si no existe, solicitarlo por el mecanismo de Meta. Más adelante se podrá evaluar activar la devolución de llamadas si el negocio quiere que WhatsApp ofrezca ese permiso después de una llamada entrante.

## 3. Arquitectura acordada

- **Cloud API:** Graph API para acciones de llamada.
- **Señalización:** Webhooks de WhatsApp Business Account, campo `calls`.
- **Medios:** WebRTC en el navegador del agente. El backend coordina la señalización, pero no recibe ni almacena el audio.
- **SIP:** fuera de alcance y desactivado.
- **PSTN:** fuera de alcance; no se puentean llamadas a teléfonos móviles o fijos tradicionales.
- **Permisos:** comprobación explícita de permiso para llamadas iniciadas por la empresa.
- **Identidad:** número telefónico o BSUID según los identificadores entregados por Meta.
- **Aislamiento:** cada evento se resuelve por `phone_number_id`; no se acepta un `account_id` enviado por el navegador como fuente de autoridad.

### Secuencia prevista

1. Meta entrega un webhook `calls` firmado.
2. WACRM valida la firma con el App Secret de la cuenta y conserva la entrega en el inbox durable existente.
3. El backend resuelve `whatsapp_config` por `phone_number_id`.
4. Se crea/actualiza la sesión de llamada y se notifica a los agentes autorizados.
5. El navegador crea el SDP answer/offer usando WebRTC y el micrófono del agente.
6. El backend envía la acción correspondiente a Meta: `connect`, `pre_accept`, `accept`, `reject` o `terminate`.
7. Los webhooks posteriores actualizan el estado y finalizan los recursos WebRTC.

El SDP y las credenciales son datos sensibles: no deben escribirse en logs, mensajes de error, analítica ni historial de conversación.

## 4. Plan por incrementos

| Incremento | Alcance | Resultado de salida |
|---|---|---|
| CALL-01 | Cliente de señalización Graph API, contratos y parsers de webhooks, pruebas unitarias y documentación | Base backend revisable; sin endpoint público ni activación |
| CALL-02 | Persistencia de sesiones y permisos, integración del webhook, rutas autenticadas y controles de concurrencia | Backend funcional en entorno de pruebas |
| CALL-03 | UI de llamada en Inbox, WebRTC, micrófono, estados, temporizador e historial | Llamadas entrantes/salientes de extremo a extremo en QA |
| CALL-04 | Flags global y por cuenta, runbook, despliegue y piloto Keyler | Activación controlada solo para Keyler; luego disponibilidad gradual |

## 5. CALL-01 — implementado en esta rama

- Cliente tipado para `POST /{PHONE_NUMBER_ID}/calls`.
- Acciones: `connect`, `pre_accept`, `accept`, `reject` y `terminate`.
- Soporte de destinatario por número E.164 y por BSUID (`recipient`).
- `messaging_account_id` opcional para cuentas que lo tengan configurado.
- Manejo de errores de Meta con código, subcódigo, HTTP status, Retry-After y fbtrace id; no se registra el token ni el SDP.
- Versión de Graph API para Calling aislada en `WHATSAPP_CALLING_API_VERSION` (por defecto `v24.0`; configurable sin alterar la versión global de mensajería); no se modifica la versión global de mensajería existente en `meta-api.ts`.
- Parser puro para `field="calls"`, eventos, estados, contactos y atributos BSUID.
- Parser para `messages[].interactive.call_permission_reply`, incluyendo expiración temporal y permiso permanente.
- Pruebas unitarias para los payloads, respuestas y validaciones.

### Fuera de CALL-01

- No se integra todavía el parser en `webhook-processor.ts`; esa integración irá junto con la persistencia de CALL-02 para no acusar eventos sin una sesión durable.
- No se crea migración ni tabla.
- No se crea endpoint de llamadas para el navegador.
- No se agrega interfaz ni código de micrófono/WebRTC.
- No se suscribe el WABA al campo `calls`.
- No se cambia ninguna configuración de Meta, VPS, variables de entorno ni producción.
- No se habilita ningún flag de llamadas.

## 6. Controles de aceptación

- Ninguna acción puede usar un número de Meta que no pertenezca a la cuenta autenticada.
- El backend exigirá rol de agente o superior para operar llamadas.
- Solo un agente puede adquirir una llamada entrante; la concurrencia se resolverá en base de datos en CALL-02.
- La llamada saliente se bloquea si el permiso del contacto no está vigente.
- Un evento duplicado no crea dos sesiones ni duplica notificaciones.
- No se guardan SDP, tokens, audio ni secretos en logs.
- Si el flag global o el flag de la cuenta está apagado, las rutas de llamadas deben fallar cerradas.
- El piloto inicial queda limitado a Keyler; todas las demás cuentas permanecen deshabilitadas.

## 7. QA y despliegue

CALL-01 se valida mediante pruebas unitarias y revisión del diff. La integración completa requiere las suites de CALL-02/03, build de producción y QA de navegador.

El despliegue en VPS se realizará únicamente después de revisar el PR, validar los checks y preparar instrucciones de backup/rollback. Ningún paso de este incremento modifica la VPS ni la configuración de Meta.

## 8. Referencias

- [Meta — Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)
- [Meta — API and Webhook Reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference/)
- [Meta — User-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls/)
- [Meta — Business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls/)
- [Meta — User call permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)
