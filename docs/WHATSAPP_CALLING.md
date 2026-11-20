# WhatsApp Calling en WACRM

**Estado:** CALL-01 validado en CI; CALL-02 implementado en rama y pendiente de QA. No desplegado.  
**Piloto previsto:** Keyler Ortega.  
**Número:** +51 980 942 247.  
**Phone Number ID:** 740434745820831.  
**App Meta:** WACRM App Oficial, App ID 1595490382304488.  
**WABA ID:** 1100749476063768.

## 1. Objetivo y alcance

Incorporar llamadas de voz nativas de WhatsApp Business Calling API dentro del Inbox de WACRM. El desarrollo es multi-tenant desde el diseño: toda sesión se resuelve por \`phone_number_id\` y la cuenta propietaria de \`whatsapp_config\`. Ningún identificador de Keyler se codifica como regla global.

El piloto empieza con Keyler. Todas las demás cuentas deben permanecer deshabilitadas hasta completar QA y habilitación gradual.

## 2. Estado de Meta confirmado

La auditoría de solo lectura de Keyler confirmó:

| Control | Resultado |
|---|---|
| App asociada al token | WACRM App Oficial — \`1595490382304488\` |
| WABA | \`1100749476063768\` |
| App suscrita a la WABA | PASS |
| Límite de mensajería | \`TIER_100K\` |
| Calling del número | \`ENABLED\` |
| Modo de permiso | \`ALLOW_APPROVED_PERMISSION_ONLY\` |
| Permiso automático de devolución | \`DISABLED\` |
| SIP | Desactivado |

El portfolio supera el requisito de límite de mensajería de al menos 2.000 destinatarios únicos en una ventana móvil de 24 horas. Ese límite no equivale a un cupo de llamadas.

### Webhooks

El panel Meta mostraba originalmente:

- \`messages\`: suscrito en v26.0.
- \`calls\`: suscrito en v26.0.

El operador confirmó que desactivó temporalmente SOLO \`calls\` y mantuvo \`messages\` activo. Esta es la configuración esperada mientras termina CALL-02. No reactivar \`calls\` hasta completar QA de recepción, persistencia e idempotencia.

La asociación de la app a \`/{WABA_ID}/subscribed_apps\` es independiente de la suscripción del campo \`calls\` en el panel Webhooks.

### Permisos y límites

- \`callback_permission_status=DISABLED\` significa que una llamada entrante no concede automáticamente permiso temporal de devolución. No impide recibir llamadas ni solicitar autorización explícita.
- \`call_permission_mode=ALLOW_APPROVED_PERMISSION_ONLY\` exige permiso aprobado antes de una llamada iniciada por la empresa.
- Los permisos temporales duran siete días; los permanentes no caducan, pero pueden revocarse.
- WACRM consulta \`GET /{PHONE_NUMBER_ID}/call_permissions\` y utiliza \`actions[].can_perform_action\` y \`actions[].limits\` de Meta como autoridad dinámica. No codifica un cupo fijo de solicitudes o llamadas.
- Las solicitudes de permiso fuera de la ventana de servicio requieren una plantilla aprobada. CALL-02 implementa por ahora solo la solicitud interactiva free-form dentro de la ventana de 24 horas.

## 3. Arquitectura

- **Cloud API:** Graph API para las acciones de llamada.
- **Señalización:** Webhooks de WhatsApp Business Account, campo \`calls\`.
- **Medios:** WebRTC en el navegador del agente. El backend coordina la señalización, pero no recibe ni almacena audio.
- **SIP y PSTN:** fuera de alcance.
- **Permisos:** comprobación explícita para llamadas iniciadas por la empresa.
- **Identidad:** teléfono o BSUID, respetando el interruptor de piloto BSUID existente.
- **Aislamiento:** el backend resuelve la cuenta desde el número de Meta; nunca confía en un \`account_id\` enviado por el navegador.

### Protección del SDP

El cuerpo original se usa para verificar HMAC. Después de validar la firma, WACRM crea una copia para el inbox durable, cifra el SDP con la clave de aplicación y elimina el SDP en claro. El inbox almacena solo el ciphertext. La sesión guarda ciphertext temporal con expiración de 90 segundos. La ruta de señalización exige que el agente haya reclamado la llamada y presenta el SDP sin caché.

No se registran tokens, App Secrets, SDP, audio ni cabeceras Authorization.

## 4. Incrementos

| Incremento | Alcance | Resultado |
|---|---|---|
| CALL-01 | Cliente de señalización Graph API, contratos, parsers y pruebas | Base backend aislada |
| CALL-02 | Persistencia, webhook durable, permisos, rutas autenticadas y claim de agentes | Backend funcional en QA |
| CALL-03 | UI de Inbox, WebRTC, micrófono, aceptar/rechazar/finalizar, estados e historial | Llamadas reales de extremo a extremo en QA |
| CALL-04 | Flags global y por cuenta, runbook, despliegue VPS y piloto Keyler | Activación controlada solo para Keyler |

## 5. CALL-01 — validado

- Cliente tipado para \`POST /{PHONE_NUMBER_ID}/calls\`.
- Acciones \`connect\`, \`pre_accept\`, \`accept\`, \`reject\` y \`terminate\`.
- Validación de número, call ID, SDP y callback data.
- Manejo de errores Meta.
- Versión Calling aislada en \`WHATSAPP_CALLING_API_VERSION\` (por defecto \`v27.0\`), sin modificar la versión global de mensajería.
- Parser de eventos \`field="calls"\` y \`interactive.call_permission_reply\`.
- CI CALL-01 #174 y #177: Lint, TypeScript, pruebas, build y regresiones PASS.

## 6. CALL-02 — backend implementado en rama

### Persistencia

La migración \`20261127000001_whatsapp_calling_backend.sql\` agrega:

- \`whatsapp_call_sessions\`: sesiones, estado, duración, identidad, SDP cifrado temporal y claim de agente.
- \`whatsapp_call_permissions\`: estado actual del permiso por contacto y número.
- \`whatsapp_call_permission_requests\`: auditoría de solicitudes y correlación de respuestas.
- RPC \`upsert_whatsapp_call_session_event\`: serializa actualizaciones por llamada y evita regresiones por eventos atrasados.
- RPC \`claim_whatsapp_call_session\`: lease atómico de 45 segundos para que solo un agente reclame una llamada entrante.
- RPC \`release_whatsapp_call_session_claim\`: libera el claim del agente propietario.

Las tablas tienen RLS habilitado y privilegios de acceso solo para service role. Las rutas autentican al agente y aplican el filtro de cuenta explícito.

### Webhook

- El procesador enruta \`field="calls"\` y persiste sesiones por \`phone_number_id + call_id\`.
- Los eventos entrantes resuelven el contacto dentro de su cuenta y reutilizan/crean la conversación.
- Los eventos de llamadas empresariales solo enlazan contactos existentes.
- Los estados de llamada separados actualizan una sesión existente, sin crear sesiones huérfanas.
- Las respuestas \`call_permission_reply\` se procesan como eventos de control, no como mensajes ordinarios. Se guarda permiso temporal, permanente o rechazo y se enlaza con la solicitud original cuando el contexto coincide.

### Rutas incorporadas

| Método y ruta | Función |
|---|---|
| \`GET /api/whatsapp/calls\` | Lista llamadas activas de la cuenta, sin exponer SDP ni claim token |
| \`POST /api/whatsapp/calls/claim\` | Reclama una llamada entrante con lease atómico |
| \`POST /api/whatsapp/calls/release\` | Libera la reclamación del agente propietario |
| \`GET /api/whatsapp/calls/signal?session_id=...\` | Entrega SDP solo al agente propietario del claim y antes de la expiración |
| \`GET /api/whatsapp/calls/permissions?contact_id=...\` | Consulta en Meta permiso y límites dinámicos |
| \`POST /api/whatsapp/calls/permissions\` | Solicita permiso interactivo dentro de la ventana de servicio |

### Límites de esta fase

- Solicitud de permiso solo para contactos con teléfono y ventana de servicio abierta.
- Contactos solo BSUID y plantillas de permiso fuera de ventana quedan pendientes.
- CALL-02 todavía no inicia, acepta ni finaliza llamadas reales desde el Inbox. La UI y el flujo WebRTC completo corresponden a CALL-03.
- El webhook \`calls\` permanece desactivado en Meta hasta que CALL-02 pase QA.
- \`messages\` permanece activado.
- No se modifican Meta, VPS, variables de entorno ni producción.

## 7. Criterios de aceptación

- Una llamada de un número de negocio solo se asocia a su propia cuenta WACRM.
- Un evento duplicado no crea una segunda sesión.
- Eventos atrasados no hacen retroceder el estado de una llamada.
- Solo un agente puede reclamar una llamada entrante a la vez.
- El SDP en claro nunca se almacena en el inbox durable ni en tablas.
- El SDP cifrado expira y solo lo recibe el agente que posee el claim válido.
- Las llamadas empresariales se bloquean sin permiso vigente y sin \`start_call.can_perform_action=true\`.
- Las solicitudes de permiso se bloquean si Meta no permite la acción o si la ventana de servicio está cerrada.
- Las respuestas de permiso no se guardan como mensajes ordinarios.
- Ninguna cuenta se habilita por defecto.

## 8. QA, activación y despliegue

CALL-02 debe superar Lint, TypeScript, pruebas unitarias, build y revisión de la migración antes de considerarse aprobado. La migración se probará en QA antes de cualquier despliegue.

El webhook \`calls\` se vuelve a activar solo cuando el consumidor esté desplegado y validado. La activación de WACRM será mediante flags global y por cuenta en CALL-04, inicialmente solo para Keyler.

El despliegue de producción lo realizará el operador en la VPS siguiendo un runbook con backup, preflight, migración, verificación y rollback. Ningún paso de este PR modifica la VPS o producción.

## 9. Referencias

- [Meta — Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)
- [Meta — Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits/)
- [Meta — Call Settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings/)
- [Meta — User Call Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/)
- [Meta — API and Webhook Reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference/)
- [Meta — User-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls/)
- [Meta — Business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls/)
- [Meta — Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)
