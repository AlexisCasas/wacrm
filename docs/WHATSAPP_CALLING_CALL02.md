# CALL-02 — Persistencia, permisos y recepción segura de WhatsApp Calling

**Estado:** desarrollo en rama; PR #136 abierto en Draft. No desplegado.  
**Base técnica:** CALL-01, PR #134.  
**Piloto previsto:** Keyler Ortega, Phone Number ID `740434745820831`.  
**App Meta:** WACRM App Oficial, App ID `1595490382304488`.  
**Configuración operativa confirmada:** `messages` activo; `calls` desactivado temporalmente. No reactivar `calls` hasta completar QA y autorizar el cambio.

## 1. Hallazgos de revisión

### 1.1 Estado de los PR

- PR #134 (CALL-01) sigue abierto en Draft; no está fusionado.
- PR #136 (CALL-02) sigue abierto en Draft; no está fusionado.
- CALL-02 se desarrolló inicialmente sobre la rama de CALL-01. Se debe conservar la relación de PR apilados: CALL-02 debe comparar contra la rama CALL-01, no duplicar su diff contra `main`.
- No se ha hecho merge, despliegue, migración en producción ni cambio adicional en Meta.

### 1.2 Fallos encontrados en CI y correcciones

- **Lint:** una descripción de prueba contenía un apóstrofo sin escapar y rompía el análisis del archivo TypeScript. Corregido.
- **Migraciones/SQL QA:** el workflow ejecutaba un archivo con varias sentencias como una consulta preparada. El script se convirtió en una sola sentencia `DO`; las fixtures sintéticas se ejecutan dentro de un subbloque que se revierte mediante una excepción centinela.
- **Prueba de permisos Meta:** el endpoint devuelve una lista de acciones, no solo `start_call`. La expectativa se amplió para comprobar también `send_call_permission_request`.
- **Orden de eventos:** se detectó que una terminación antigua podía limpiar el SDP de una llamada más reciente. La actualización ahora compara `meta_timestamp` antes de modificar estado, SDP, expiración, duración o datos de finalización.
- **Identidad:** se añadió soporte separado para BSUID y parent BSUID; no se copia un BSUID al campo teléfono.
- **Concurrencia:** se añadió una reserva atómica de llamada por agente con lease de 90 segundos y liberación controlada.

### 1.3 Resultado de la última ejecución CI completa observada

En la ejecución #195, sobre una revisión anterior a los últimos cambios:

- Lint: PASS.
- Typecheck: PASS.
- Tests: 4.598 pasaron; 1 falló por una expectativa incompleta en la lista de acciones de permisos.
- Build: omitido porque la suite de tests falló.

La ejecución de migraciones #84 había pasado la reproducción y las comprobaciones de CALL-02 de aquella revisión. Después se añadieron las reservas de agente y la auditoría de solicitudes de permiso; por ello, el replay final de la migración actual debe volver a ejecutarse y aprobarse. No se considera cerrado por el resultado anterior.

## 2. Implementación actual

### 2.1 Modelo de datos

- `whatsapp_call_sessions`: estado de cada llamada, identidad de cliente, SDP cifrado y lease del agente que la atiende.
- `whatsapp_call_events`: registro mínimo e idempotente de eventos; no conserva el payload Meta ni SDP.
- `whatsapp_call_permissions`: último permiso aprobado/rechazado, tipo, expiración y origen de la respuesta.
- `whatsapp_call_permission_requests`: auditoría de solicitudes salientes, agente que la envió, WAMID y respuesta correlacionada cuando Meta devuelve el contexto.

Las cuatro tablas tienen RLS y privilegios restringidos al rol `service_role`; no se exponen directamente al navegador.

### 2.2 Webhook durable

- `field=calls` se deriva al procesador Calling después de que la ruta general valide la firma HMAC y encole el payload en el inbox durable.
- Los estados de llamada no pasan al procesador de estados de mensajes.
- Las respuestas `interactive.call_permission_reply` se procesan en el webhook `messages`, que permanece activo.
- La cuenta se resuelve exclusivamente por `whatsapp_config.phone_number_id`.
- Un evento duplicado no vuelve a aplicar la mutación.
- Eventos antiguos no pueden reabrir llamadas terminales ni reemplazar un SDP más reciente.
- Los eventos de terminación limpian SDP y liberan la reserva del agente.

### 2.3 SDP y seguridad

- El SDP se cifra con el mecanismo GCM existente antes de persistirlo.
- La expiración lógica es de cinco minutos.
- La API solo descifra y entrega el SDP al agente autenticado que posee una reserva vigente de esa llamada.
- No se registran tokens, SDP ni payloads completos.
- El audio no pasa por el backend: WebRTC del navegador se implementará en CALL-03.

### 2.4 Reserva de llamada por agente

- `whatsapp_call_claim` realiza una actualización atómica; solo un agente puede obtener la reserva vigente.
- `whatsapp_call_sdp_prune` elimina SDP cifrado expirado en lotes acotados; la limpieza es oportunista al usar la API y no hay cron dedicado en CALL-02.
- La reserva dura 90 segundos. Repetir la acción desde el mismo agente renueva el lease.
- `whatsapp_call_release` permite liberar la reserva propia; owner/admin pueden liberar una reserva de la cuenta.
- Las funciones verifican que el actor sea miembro de la cuenta con rol owner/admin/agent.
- Las funciones y tablas siguen siendo invocables/consultables solo desde servidor mediante `service_role`.

## 3. Rutas autenticadas añadidas

Todas requieren `requireRole('agent')` o superior y filtran por el `account_id` resuelto desde la sesión autenticada.

| Ruta | Acción |
|---|---|
| `GET /api/whatsapp/calls` | Lista las últimas 50 llamadas de la cuenta. |
| `GET /api/whatsapp/calls?call_id=...` | Consulta una llamada; solo entrega SDP al agente que posee la reserva vigente. |
| `POST /api/whatsapp/calls` con `action=claim` | Reserva una llamada entrante. |
| `POST /api/whatsapp/calls` con `action=release` | Libera la reserva. |
| `POST /api/whatsapp/calls` con `action=check_permission` | Consulta el permiso y las cuotas reales de Meta para el contacto. |
| `POST /api/whatsapp/calls` con `action=request_permission` | Comprueba `can_perform_action` y solicita permiso al cliente; registra el WAMID para correlacionar la respuesta. |

La ruta de permiso acepta `call_id` o `contact_id`; resuelve teléfono/BSUID dentro de la misma cuenta. Si Meta no permite solicitar el permiso, WACRM no envía el mensaje.

No se exponen todavía acciones `connect`, `accept`, `pre_accept`, `reject` o `terminate` al navegador. Las acciones que necesitan SDP generado por WebRTC corresponden a CALL-03.

## 4. Permisos y límites de Meta

- `GET /{PHONE_NUMBER_ID}/call_permissions` es la fuente autoritativa para consultar el permiso actual y las acciones permitidas.
- WACRM consulta `can_perform_action` para `start_call` y `send_call_permission_request`; no decide únicamente por el estado guardado localmente.
- El helper exige exactamente un identificador: `user_wa_id` o `recipient` (BSUID), evitando consultas ambiguas.
- La solicitud interactiva solo se envía si Meta informa que `send_call_permission_request` está permitido.
- La respuesta explícita puede ser temporal, permanente o de rechazo; también se registra `response_source` cuando Meta lo proporciona.
- El permiso local es una proyección/auditoría; antes de iniciar una llamada empresarial se volverá a consultar Meta.

## 5. QA y estado pendiente

- [x] Corrección del error de sintaxis en la prueba de Calling.
- [x] Script SQL convertido en una única sentencia y con rollback de fixtures.
- [x] Prueba de deduplicación de eventos.
- [x] Prueba de evento de terminación fuera de orden.
- [x] Prueba de aislamiento de tenant y grants/RLS.
- [x] Pruebas de permisos temporales/permanentes/rechazados.
- [x] Helpers Meta de consulta y solicitud de permiso.
- [x] Procesador durable integrado.
- [x] Rutas autenticadas de consulta, reserva y permisos añadidas.
- [x] Limpieza acotada de SDP expirado integrada en la API.
- [ ] CI completo sobre el HEAD actual: lint, typecheck, tests y build.
- [ ] Replay de la migración actual, incluyendo lease y tabla de auditoría.
- [ ] Revisión formal de seguridad de rutas y reservas.
- [ ] Prueba de extremo a extremo con webhook sintético firmado en entorno aislado.

## 6. Fuera de alcance y condiciones de activación

- No activar ni modificar el webhook `calls` en Meta durante CALL-02.
- No iniciar ni contestar llamadas reales.
- No implementar WebRTC ni interfaz de llamada; corresponde a CALL-03.
- No modificar VPS, producción, secretos ni variables de entorno.
- No aplicar migraciones en Supabase Cloud de producción.
- No fusionar CALL-01/CALL-02 ni desplegar hasta completar QA y recibir autorización.

**Condición operativa:** mantener `calls` desactivado y `messages` activado. La reactivación se hará únicamente después de CALL-02/03, QA integral y autorización expresa.


## 7. Hallazgo crítico adicional — migración SQL reconstruida

Durante la revisión posterior se detectó que la migración CALL-02 del HEAD previo estaba dañada: la definición de `whatsapp_call_permission_requests` quedó truncada, había bloques SQL duplicados/intercalados y varias funciones usaban delimitadores dollar-quote incompletos (`AS $` / `END $`). Esa versión no era apta para PostgreSQL y no debía aplicarse en ningún entorno.

**Corrección aplicada:** commit `0847bd69320843bb823c466734ba944269b53c6a`. Se reconstruyó el archivo completo manteniendo el contrato requerido por el procesador, la API y `verify.sql`:
- cuatro tablas: sesiones, eventos, permisos y solicitudes de permisos;
- RLS y privilegios exclusivos de `service_role`;
- RPCs `whatsapp_call_event_apply`, `whatsapp_call_sdp_prune`, `whatsapp_call_claim`, `whatsapp_call_release` y `whatsapp_call_permission_upsert`;
- firma de funciones alineada con el script de QA y los argumentos usados por TypeScript.

La corrección está en GitHub, pero **no se considera validada hasta que Migrations #111 complete el replay de todas las migraciones y el script CALL-02**. No aplicar esta migración en Supabase Cloud ni en producción antes de ese resultado.

### Ejecuciones sobre la corrección
- CI #214: en ejecución al documentar este hallazgo.
- Migrations #111: en cola/alistándose al documentar este hallazgo.
- PR #136 continúa en Draft; sin merge ni despliegue.
