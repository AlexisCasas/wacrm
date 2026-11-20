# WhatsApp Calling en WACRM — plan y CALL-01

**Estado:** desarrollo inicial en rama; no habilitado en producción.  
**Piloto previsto:** cuenta de Keyler Ortega.  
**Número confirmado por el operador:** +51 980 942 247.  
**Phone Number ID confirmado por la captura de Meta:** 740434745820831.

## 1. Objetivo

Incorporar llamadas de voz nativas de WhatsApp Business Calling API dentro del Inbox de WACRM, empezando por una única cuenta piloto y manteniendo la capacidad deshabilitada para el resto de cuentas hasta superar QA y el despliegue controlado.

La solución será multi-tenant desde el diseño: toda sesión y todo evento se asociará al `phone_number_id` de Meta y a la cuenta propietaria de `whatsapp_config`. No se utilizará un identificador global de Keyler en el código.

## 2. Configuración de Meta observada

La aplicación asociada al token de Keyler es `WACRM App Oficial` (App ID `1595490382304488`). El operador confirmó que el nombre visible ya fue actualizado, conservando el mismo App ID.

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

Los límites de llamadas son independientes: Meta limita las llamadas conectadas a 100 por cada par número de empresa/usuario de WhatsApp en 24 horas. Las solicitudes de permiso están limitadas a una por 24 horas y dos en siete días por ese mismo par.

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

## 5. CALL-01 — implementado en esta rama

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
- La captura de Meta Developers del 19-nov-2026 mostró `calls` SUSCRITO en la app (entonces llamada `WACRM Lorteg Temporal`) con versión de campo `v26.0`; el operador confirmó después que desactivó `calls` y mantuvo `messages` activado.
- Acción operativa requerida antes de continuar: desactivar temporalmente SOLO el campo `calls` en Meta Developers y conservar `messages` activo. La suscripción `calls` ya estaba habilitada antes de que WACRM tuviera su consumidor.
- Motivo: el webhook actual valida y encola el payload, pero `processWebhook` todavía no enruta `field="calls"`. El drenaje durable puede marcar el evento como procesado sin manejar la llamada. No volver a activar `calls` hasta que CALL-02 integre el manejador, persistencia e idempotencia y pase QA.
- No se cambia ninguna configuración de Meta, VPS, variables de entorno ni producción.
- No se habilita ningún flag de llamadas.

### Límites y permisos que CALL-02 debe respetar

- Hasta 100 llamadas conectadas cada 24 horas por pareja número empresarial/usuario de WhatsApp.
- Máximo 1 solicitud de permiso en 24 horas y 2 en 7 días por esa pareja.
- Los permisos temporales duran 7 días; los permanentes no caducan, pero el usuario puede revocarlos.
- Dos llamadas empresariales consecutivas sin respuesta provocan un aviso para reconsiderar el permiso; cuatro pueden revocarlo automáticamente.
- No inferir permiso de una conversación abierta ni de un mensaje ordinario.

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
- [Meta — Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits/)
- [Meta — Call Settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings/)
- [Meta — User Call Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — API and Webhook Reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference/)
- [Meta — User-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls/)
- [Meta — Business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls/)
- [Meta — User call permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)


## 9. Actualización CALL-02 — 19/nov/2026

**Estado:** desarrollo en PR #136 (Draft), todavía sin merge ni despliegue. PR #134 (CALL-01) también permanece abierto en Draft.

### Configuración Meta confirmada por el operador

- Nombre visible de la aplicación actualizado a **WACRM App Oficial**; App ID sin cambios: `1595490382304488`.
- Webhook `messages`: activo.
- Webhook `calls`: desactivado temporalmente.
- Calling API: habilitado para el número piloto.
- No reactivar `calls` hasta que el backend y el QA integral estén cerrados.

### Avance de CALL-02

- Persistencia idempotente de sesiones, eventos y permisos.
- SDP cifrado y de corta duración.
- Procesamiento de `field=calls` en el inbox durable y de `call_permission_reply` en el webhook `messages`.
- Registro de origen de autorización (acción del usuario o revocación automática) y correlación con el mensaje que solicitó el permiso.
- Reserva atómica de llamada por agente con lease de 90 segundos.
- Rutas autenticadas para listar llamadas, consultar el detalle, reservar/liberar y consultar/solicitar permisos a Meta.
- El SDP solo se entrega al agente que tiene la reserva vigente.
- Se documentaron y corrigieron un evento de terminación fuera de orden y errores detectados por CI.

### Hallazgos de QA

La última ejecución completa observada tuvo Lint y Typecheck en PASS; la suite reportó 4.598 pruebas aprobadas y una expectativa incompleta en el test de acciones de permisos Meta. La expectativa fue corregida. Después se ampliaron la migración, el registro de solicitudes y las rutas autenticadas, por lo que el CI y el replay de migraciones deben repetirse sobre el HEAD actual.

### Próximos pasos

1. Cerrar CI y replay de migraciones sobre el HEAD actual.
2. Completar revisión formal de aislamiento multi-tenant, claims y permisos.
3. Finalizar CALL-02.
4. CALL-03: interfaz del Inbox y WebRTC.
5. CALL-04: despliegue controlado y piloto exclusivo de Keyler.

**No se han realizado cambios en VPS, producción, Supabase Cloud ni en la configuración Meta desde la desactivación temporal de `calls`.**


## 10. Hallazgo de revisión SQL — CALL-02

En la revisión del 19/nov se encontró que la primera versión de la migración CALL-02 estaba truncada y contenía bloques duplicados, por lo que no era válida para PostgreSQL. Se reconstruyó completa en el commit `0847bd69320843bb823c466734ba944269b53c6a`, incluyendo las tablas de sesiones, eventos, permisos y solicitudes, junto con los RPCs de idempotencia, limpieza de SDP y reserva/liberación por agente.

La corrección está pendiente de validación automatizada mediante Migrations #112 y CI #215. No aplicar a Supabase Cloud ni producción, no fusionar y no reactivar el webhook `calls` hasta que ambos checks y la revisión formal estén cerrados.
