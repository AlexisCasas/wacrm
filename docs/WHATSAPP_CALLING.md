# WhatsApp Calling en WACRM — plan y CALL-01

**Estado:** desarrollo inicial en rama; no habilitado en producción.  
**Piloto previsto:** cuenta de Keyler Ortega.  
**Número confirmado por el operador:** +51 980 942 247.  
**Phone Number ID confirmado por la captura de Meta:** 740434745820831.

## 1. Objetivo

Incorporar llamadas de voz nativas de WhatsApp Business Calling API dentro del Inbox de WACRM, empezando por una única cuenta piloto y manteniendo la capacidad deshabilitada para el resto de cuentas hasta superar QA y el despliegue controlado.

La solución será multi-tenant desde el diseño: toda sesión y todo evento se asociará al `phone_number_id` de Meta y a la cuenta propietaria de `whatsapp_config`. No se utilizará un identificador global de Keyler en el código.

## 2. Configuración de Meta observada

La aplicación asociada al token de Keyler es la misma App ID `1595490382304488`, cuyo nombre visible el operador confirmó actualizado a `WACRM App Oficial` (antes `WACRM Lorteg Temporal`). No se creó otra app ni cambió el App ID.

La captura de WhatsApp Manager para el número de Keyler muestra:

| Ajuste | Estado observado | Decisión |
|---|---|---|
| Permitir llamadas de voz | Activado | Correcto |
| Mostrar botones de llamada | Activado | Correcto |
| Horario de disponibilidad | Sin horario específico configurado | Meta considera el número disponible todo el tiempo |
| Detener temporalmente llamadas entrantes | Sin configuración observada | No configurar en esta fase |
| Permitir devolución de llamadas (`callback_permission_status`) | Desactivado | No impide recibir llamadas. Sí impide que una llamada entrante conceda automáticamente permiso temporal para devolver la llamada |
| Modo de permiso (`call_permission_mode`) | `ALLOW_APPROVED_PERMISSION_ONLY` | Mantener: las llamadas iniciadas por la empresa requieren permiso aprobado del cliente |
| SIP | Desactivado | Mantener desactivado; se usará la señalización estándar de Calling API y WebRTC |

La pestaña **Calling limits** debe revisarse antes de las pruebas reales. Además, Meta exige que el portfolio de negocio tenga un límite de mensajería de al menos **2.000 destinatarios únicos en una ventana móvil de 24 horas**. Este requisito es un límite de MENSAJERÍA, no significa que se permitan 2.000 llamadas diarias. Se consulta en WhatsApp Manager → Account tools → Messaging limits o mediante el campo `whatsapp_business_manager_messaging_limit` del número/portfolio. El valor mínimo aceptable es `TIER_2K` o superior.

Los límites de llamadas y solicitudes de permiso son independientes del nivel de mensajería. CALL-02 consulta `GET /{PHONE_NUMBER_ID}/call_permissions` y utiliza los valores dinámicos de `actions[].can_perform_action` y `actions[].limits` que devuelve Meta. WACRM no debe asumir ni codificar un cupo fijo: la respuesta de Meta es la autoridad para cada cliente y momento.

### Permiso de devolución

Con `callback_permission_status` desactivado, una llamada entrante no concede automáticamente el permiso temporal de devolución. Esto no bloquea las llamadas entrantes ni el mecanismo alternativo de solicitar permiso explícito mediante un mensaje interactivo o una plantilla. Como `call_permission_mode` está en `ALLOW_APPROVED_PERMISSION_ONLY`, WACRM debe consultar `GET /{PHONE_NUMBER_ID}/call_permissions` antes de iniciar una llamada empresarial y exigir `temporary` vigente o `permanent`; si no existe, debe solicitar autorización y esperar la respuesta del usuario. Perú está dentro de las ubicaciones admitidas para llamadas iniciadas por la empresa. Más adelante se podrá evaluar activar la devolución de llamadas si el negocio quiere que WhatsApp ofrezca ese permiso después de una llamada entrante.

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
2. WACRM resuelve el App Secret del tenant mediante `phone_number_id`/WABA y valida la firma antes de encolar el payload.
3. El evento verificado se conserva en el inbox durable existente.
4. El backend resuelve `whatsapp_config` por `phone_number_id` y crea/actualiza la sesión de llamada.
5. Se notifica a los agentes autorizados.
6. El navegador crea el SDP answer/offer usando WebRTC y el micrófono del agente.
7. El backend envía la acción correspondiente a Meta: `connect`, `pre_accept`, `accept`, `reject` o `terminate`.
8. Los webhooks posteriores actualizan el estado y finalizan los recursos WebRTC.

El SDP y las credenciales son datos sensibles: no deben escribirse en logs, mensajes de error, analítica ni historial de conversación.

## 4. Plan por incrementos

| Incremento | Alcance | Resultado de salida |
|---|---|---|
| CALL-01 | Cliente de señalización Graph API, contratos y parsers de webhooks, pruebas unitarias y documentación | Base backend revisable; sin endpoint público ni activación |
| CALL-02 | Persistencia de sesiones y permisos; integración del webhook; rutas autenticadas; consulta `GET /{PHONE_NUMBER_ID}/call_permissions`; solicitud de permisos por mensajes; controles de concurrencia; suscripción de `calls` solo al finalizar el QA | Backend funcional en entorno de pruebas |
| CALL-03 | UI de llamada en Inbox, WebRTC, micrófono, estados, temporizador e historial | Llamadas entrantes/salientes de extremo a extremo en QA |
| CALL-04 | Flags global y por cuenta, runbook, despliegue y piloto Keyler | Activación controlada solo para Keyler; luego disponibilidad gradual |

## 5. CALL-01 — implementado en la rama base

- Cliente tipado para `POST /{PHONE_NUMBER_ID}/calls`.
- Acciones: `connect`, `pre_accept`, `accept`, `reject` y `terminate`.
- Validación local de número, call ID, SDP y callback data.
- Manejo de errores de Meta sin registrar token ni SDP.
- Versión de Graph API para Calling aislada en `WHATSAPP_CALLING_API_VERSION` (por defecto `v27.0`).
- Parser de eventos `field="calls"` y `interactive.call_permission_reply`.
- CI #174 y #177 PASS en la rama CALL-01.

## 6. CALL-02 — backend en desarrollo

### Persistencia y recepción segura

- Migración `20261127000001_whatsapp_calling_backend.sql` crea sesiones de llamada, permisos de contacto y auditoría de solicitudes de permiso.
- Las tablas nuevas tienen RLS habilitado y acceso solo al service role. Las rutas autentican agentes y aplican filtro explícito por `account_id`.
- La ruta de webhook verifica la firma HMAC del cuerpo original. Antes de guardar el payload en la bandeja durable, cifra el SDP con la clave de aplicación y elimina el SDP en claro.
- El SDP cifrado expira a los 90 segundos y solo se entrega por una ruta autenticada al agente que haya reclamado la llamada.
- Los eventos se guardan con clave única por `phone_number_id + call_id`, bloqueo transaccional y protección contra eventos atrasados que hagan retroceder el estado.
- Los eventos de llamadas entrantes resuelven el contacto dentro de la cuenta y reutilizan/crean la conversación; las llamadas empresariales solo enlazan contactos existentes.
- Las respuestas `call_permission_reply` se procesan como eventos de control, no como mensajes ordinarios. Se registra permiso temporal, permanente o rechazo y se enlaza con la solicitud original cuando el contexto coincide.

### Rutas incorporadas

| Método y ruta | Función |
|---|---|
| `GET /api/whatsapp/calls` | Lista llamadas activas de la cuenta autenticada, sin exponer SDP ni tokens de reclamación |
| `POST /api/whatsapp/calls/claim` | Reclama una llamada entrante con lease atómico de 45 segundos |
| `POST /api/whatsapp/calls/release` | Libera la reclamación del agente propietario |
| `GET /api/whatsapp/calls/signal?session_id=...` | Entrega SDP cifrado solo al agente que posee el claim token y antes de su expiración |
| `GET /api/whatsapp/calls/permissions?contact_id=...` | Consulta en Meta el permiso y los límites dinámicos del contacto |
| `POST /api/whatsapp/calls/permissions` | Solicita permiso mediante mensaje interactivo dentro de la ventana de servicio de 24 horas |

### Límites explícitos de CALL-02

- Las solicitudes de permiso por ahora se limitan a contactos con número telefónico y ventana de servicio abierta. Contactos solo BSUID y solicitudes mediante plantilla fuera de ventana quedan pendientes de una fase posterior.
- Todavía no se inicia ni se acepta una llamada real desde el Inbox; eso requiere WebRTC y la interfaz de CALL-03.
- No se activa el webhook `calls` durante el desarrollo. El operador lo mantiene desactivado; `messages` sigue activo.
- No se realizan cambios en Meta, VPS, variables de entorno ni producción.

## 7. CALL-03 y CALL-04 — pendientes

| Incremento | Alcance |
|---|---|
| CALL-03 | UI de llamada en Inbox, WebRTC, micrófono, aceptar/rechazar/finalizar, señalización completa, estados e historial |
| CALL-04 | Flags global y por cuenta, runbook, despliegue en VPS, suscripción controlada del webhook `calls` y piloto exclusivo con Keyler |

## 8. Controles de aceptación

- Cliente tipado para `POST /{PHONE_NUMBER_ID}/calls`.
- Acciones: `connect`, `pre_accept`, `accept`, `reject` y `terminate`.
- Soporte de destinatario por número E.164 (`to`).
- `messaging_account_id` opcional para cuentas que lo tengan configurado.
- Manejo de errores de Meta con código, subcódigo, HTTP status, Retry-After y fbtrace id; no se registra el token ni el SDP.
- Versión de Graph API para Calling aislada en `WHATSAPP_CALLING_API_VERSION` (por defecto `v27.0`; configurable sin alterar la versión global de mensajería); no se modifica la versión global de mensajería existente en `meta-api.ts`.
- Parser puro para `field="calls"`, eventos, estados, contactos y atributos BSUID.
- Parser para `messages[].interactive.call_permission_reply`, incluyendo expiración temporal y permiso permanente.
- Pruebas unitarias para los payloads, respuestas y validaciones.

### Fuera de CALL-01

- No se integra todavía el parser en `webhook-processor.ts`; esa integración irá junto con la persistencia de CALL-02 para no acusar eventos sin una sesión durable.
- No se crea migración ni tabla.
- No se crea endpoint de llamadas para el navegador.
- No se agrega interfaz ni código de micrófono/WebRTC.
- La captura de Meta Developers del 19-nov-2026 mostró `calls` suscrito en v26.0 y `messages` suscrito en v26.0.
- El operador confirmó después que desactivó temporalmente SOLO `calls` y conservó `messages` activo.
- No volver a activar `calls` hasta que el manejador durable, la persistencia, la idempotencia y el QA de CALL-02 estén completos.
- No se cambia ninguna configuración de Meta, VPS, variables de entorno ni producción.
- No se habilita ningún flag de llamadas.

### Límites y permisos que CALL-02 debe respetar

- Hasta 100 llamadas conectadas cada 24 horas por pareja número empresarial/usuario de WhatsApp.
- Máximo 1 solicitud de permiso en 24 horas y 2 en 7 días por esa pareja.
- Los permisos temporales duran 7 días; los permanentes no caducan, pero el usuario puede revocarlos.
- Dos llamadas empresariales consecutivas sin respuesta provocan un aviso para reconsiderar el permiso; cuatro pueden revocarlo automáticamente.
- No inferir permiso de una conversación abierta ni de un mensaje ordinario.

## 9. Controles de aceptación

- Ninguna acción puede usar un número de Meta que no pertenezca a la cuenta autenticada.
- El backend exigirá rol de agente o superior para operar llamadas.
- Solo un agente puede adquirir una llamada entrante; la concurrencia se resolverá en base de datos en CALL-02.
- La llamada saliente se bloquea si el permiso del contacto no está vigente.
- Un evento duplicado no crea dos sesiones ni duplica notificaciones.
- No se guardan SDP, tokens, audio ni secretos en logs.
- Si el flag global o el flag de la cuenta está apagado, las rutas de llamadas deben fallar cerradas.
- El piloto inicial queda limitado a Keyler; todas las demás cuentas permanecen deshabilitadas.

## 10. QA y despliegue

CALL-01 se valida mediante pruebas unitarias y revisión del diff. La integración completa requiere las suites de CALL-02/03, build de producción y QA de navegador.

El despliegue en VPS se realizará únicamente después de revisar el PR, validar los checks y preparar instrucciones de backup/rollback. Ningún paso de este incremento modifica la VPS ni la configuración de Meta.

## 11. Referencias

- [Meta — Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)
- [Meta — Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits/)
- [Meta — Call Settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings/)
- [Meta — User Call Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — API and Webhook Reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference/)
- [Meta — User-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls/)
- [Meta — Business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls/)
- [Meta — User call permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)
