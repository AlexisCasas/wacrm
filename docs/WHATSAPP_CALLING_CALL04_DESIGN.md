# WACRM — CALL-04: diseño de piloto real controlado

**Estado:** DISEÑO PROPUESTO — no implementado, no autorizado para activación.

## 1. Objetivo

Introducir Calling API real de Meta en WACRM mediante un piloto pequeño, reversible y medible, manteniendo el modelo actual de Inbox/WebRTC, atribución de agente y persistencia por tenant.

CALL-04 no es una habilitación general. El primer alcance debe limitarse a un número empresarial, un contacto de piloto ya aprobado y uno o pocos agentes autorizados. Las llamadas reales solo comienzan después de completar los gates de este documento y recibir autorización operativa explícita.

## 2. Estado de partida

- CALL-03 completó T1–T4 en QA sintético. T3A fue una simulación de estado ICE; T3B fue una desconexión persistente real entre los peers de QA.
- La aplicación QA está en `8c4d37b90e4d2def7f7a60154ace07d36c19f4f7`, imagen `wacrm-app:call03b2-history-8c4d37b`.
- El mock Graph/peer sigue siendo QA-only. `graph.facebook.com` resuelve a loopback dentro del stack QA.
- El webhook real `calls` sigue desactivado. Producción no fue modificada.
- El parser/procesador actual ya reconoce `start_time`, `end_time` y `duration`; el mock requiere alineación y una prueba integral de esos campos.
- `CallingPanel.acceptIncoming` solicita el micrófono antes del claim. Corregir ese orden es un gate previo al primer piloto real.

## 3. Dependencias técnicas y orden de integración

### 3.1 Stack GitHub

| Orden | PR | Incremento | Estado actual | Gate del HEAD revisado |
|---:|---|---|---|---|
| 1 | [#134](https://github.com/AlexisCasas/wacrm/pull/134) | CALL-01: base Calling | Open, no draft | CI #241 PASS |
| 2 | [#136](https://github.com/AlexisCasas/wacrm/pull/136) | CALL-02: webhooks, eventos y permisos | Open, Draft | CI #252 PASS; Migrations #147 PASS |
| 3 | [#137](https://github.com/AlexisCasas/wacrm/pull/137) | CALL-03A: atribución, claims y metadata | Open, Draft | CI #294 PASS; Migrations #186 PASS |
| 4 | [#138](https://github.com/AlexisCasas/wacrm/pull/138) | CALL-03B1: señalización y ciclo SDP | Open, Draft | CI #326 PASS; Migrations #218 PASS |
| 5 | [#140](https://github.com/AlexisCasas/wacrm/pull/140) | CALL-03B2: Inbox y WebRTC | Open, Draft | CI #373 PASS; Migrations #237 PASS |
| 6 | [#142](https://github.com/AlexisCasas/wacrm/pull/142) | CALL-03B2.1: asociación entrante e historial | Open, Draft | CI #419 PASS; Migrations #283 PASS |

**Bloqueo de integración:** CALL-01 (#134) y CALL-02 (#136) aún no están fusionados en `main`. Antes de CALL-04 se deben revisar y fusionar los PR apilados en el orden anterior, resolver conflictos, repetir CI/Migrations y ejecutar un replay limpio sobre el resultado integrado.

PR #141 es el simulador Graph/peer y los overlays de QA; permanece fuera de los artefactos de producción. PR #139 fue cerrado sin merge porque quedó supersedido por #140.

### 3.2 Hardening obligatorio heredado de CALL-03

1. **Privacidad del micrófono:** cambiar el orden UIC a `click → claim atómico → getUserMedia → renovar/revalidar claim y SDP → WebRTC → pre_accept → esperar 200 → accept`. Si el claim responde 409, no debe invocarse `getUserMedia`. Si el usuario deniega el micrófono, liberar el claim. Si el prompt tarda más que el lease/TTL, no continuar con SDP vencido.
2. **Contrato de timestamps:** alinear el mock con Meta: `start_time`, `end_time` y `duration` solo en terminaciones de llamadas atendidas. Añadir pruebas para llamada atendida y no atendida. No inventar duración local cuando Meta no entrega los campos.
3. **T3A real:** mantener el PASS simulado como evidencia unitaria; ejecutar una prueba de pérdida/recuperación real de red en QA, desde un cliente de prueba, antes de ampliar el piloto.
4. **Perfiles de QA:** los agentes que se utilicen para demostración deben tener `full_name`; el dato faltante de A/B no es un defecto de aislamiento.
5. **TURN/NAT:** el cliente actual no tiene proveedor TURN configurado. Validar conectividad desde las redes reales de los agentes. Si STUN no es suficiente, definir un proveedor TURN y guardar credenciales exclusivamente del lado servidor; no exponerlas en `NEXT_PUBLIC_*`.

## 4. Prerrequisitos Meta — preflight de solo lectura

CALL-04A debe verificar los puntos siguientes sin cambiar configuración:

1. **Número empresarial:** confirmar `phone_number_id`, WABA, país del número y que el número está en uso con Cloud API, no solo con WhatsApp Business App.
2. **Límite de mensajería:** Meta exige un límite diario de al menos 2,000 destinatarios únicos para habilitar Calling en un número empresarial normal. Los números de prueba/sandbox tienen reglas distintas.
3. **Aplicación Meta:** la misma app debe estar suscrita al campo webhook `calls` y al Messaging Account del número; debe contar con el permiso `whatsapp_business_messaging`.
4. **Calling settings:** leer el estado efectivo. Calling está deshabilitado por defecto; no se debe asumir que está habilitado por el hecho de que el código exista.
5. **SIP:** confirmar que SIP no está habilitado para este número, porque el diseño WACRM usa Graph API + Webhooks + WebRTC. SIP puede cambiar el transporte y el comportamiento de los webhooks.
6. **Disponibilidad BIC:** comprobar el país del número empresarial. Meta indica que Business-Initiated Calling está disponible en ubicaciones Cloud API salvo Estados Unidos, Canadá, Egipto, Vietnam y Nigeria.
7. **Permisos BIC:** por defecto, exigir permiso aprobado por el usuario. No asumir elegibilidad para el modelo quality-based: la documentación lo marca como disponibilidad limitada para números elegibles de países específicos, incluidos Colombia y México. Solo cambiar el modo de permiso si Meta confirma elegibilidad del número.
8. **Call hours:** revisar horarios semanales, feriados y zona horaria. Propuesta para evaluación: `America/Lima`, con horario aprobado por operaciones; no aplicar hasta autorización.
9. **Call icon visibility:** decidir si el piloto debe bloquear llamadas entrantes no solicitadas. Para un piloto exclusivamente BIC se puede evaluar `DISABLE_ALL`; Meta indica que oculta los puntos de entrada de llamadas no solicitadas, aunque los CTA de llamadas en mensajes siguen siendo posibles. Si se quiere probar UIC, definir expresamente cómo se permitirá esa entrada.
10. **Versión Graph:** el cliente de Calling usa `WHATSAPP_CALLING_API_VERSION` con default actual `v27.0`. Mantener la versión fijada y revisar el changelog de Meta antes de cambiarla.

**No activar ni modificar nada durante CALL-04A.** Guardar solo valores no secretos, estado, fecha y evidencia de lectura.

## 5. Modelo funcional propuesto

### 5.1 Business-Initiated Calling (BIC)

- Solo iniciar desde una acción explícita del agente en el Inbox.
- Consultar en servidor el permiso Meta y la cuota `start_call` inmediatamente antes de `connect`.
- Para el primer piloto, exigir permiso aprobado vigente; no inferirlo de mensajes, de un permiso antiguo o de la configuración del browser.
- Enviar permiso interactivo solo por acción explícita del agente, respetando los límites de Meta.
- Mantener `request_id` idempotente y el estado `unknown` sin reintento automático cuando el resultado de Meta sea incierto.
- Correlacionar la llamada con `call_id` y `biz_opaque_callback_data`; no depender de callback data para el webhook inicial `connect`.
- El webhook `ACCEPTED` puede llegar después de que la llamada ya esté establecida; tratarlo como evento de auditoría/estado, no como señal para iniciar audio.

### 5.2 User-Initiated Calling (UIC)

- Recibir `connect` firmado y persistido; asociar el número/contacto dentro del tenant identificado por `phone_number_id`.
- Mostrar la llamada únicamente en la conversación correcta.
- Claim atómico antes de solicitar micrófono.
- Meta da aproximadamente 30–60 segundos para aceptar la llamada entrante; respetar TTL de SDP y lease, y rechazar de forma segura si han vencido.
- `pre_accept` es recomendado para establecer la conexión con rapidez. Mantener el audio local/remoto bloqueado hasta que el endpoint `accept` responda HTTP 200.
- Si el usuario rechaza, la app cambia de conversación, deniega micrófono o falla WebRTC, liberar recursos y terminar/rechazar de forma idempotente.

### 5.3 Finalización e historial

- El webhook `terminate` es la fuente canónica del resultado final de Meta.
- `COMPLETED` puede representar también una llamada no atendida; `start_time`, `end_time` y `duration` solo están presentes si la otra parte atendió.
- Si esos campos faltan, conservar `NULL` y mostrar un estado coherente; no inferir duración desde el temporizador del browser.
- Persistir atribución de agente, conversación, estado final, errores Meta y timestamps sin guardar SDP en logs.

## 6. Arquitectura y límites de confianza

1. **Browser / Inbox:** solo envía acciones de usuario. No contiene tokens Meta, App Secret, service role, SDP persistente ni secretos TURN.
2. **API `/api/whatsapp/calls`:** `requireRole('agent')`; obtiene `account_id` y `user_id` de la sesión autenticada. Ignora cualquier `account_id` enviado por el browser.
3. **Feature gate:** validación server-side de cuenta, `phone_number_id`, contacto/BSUID y agente autorizado. El allowlist del browser es solo UX, nunca autorización.
4. **Meta client:** token descifrado solo en servidor; Graph API `v27.0`; valida acción, call ID, recipient y SDP.
5. **Webhook `/api/whatsapp/webhook`:** verifica HMAC SHA-256 sobre los bytes originales del body con `x-hub-signature-256`, resolviendo secretos por tenant. No ejecutar lógica de negocio antes de verificar firma.
6. **Durable inbox:** encolar el payload verificado antes de responder 200; procesamiento inmediato y cron usan leases atómicos, idempotencia y retry/backoff.
7. **Calling processor/RPC:** resuelve tenant solo por `phone_number_id`, procesa eventos idempotentes, aplica orden temporal, persiste actor/conversación y mantiene SDP cifrado y efímero.
8. **PostgreSQL:** RPC de claim/lease y acciones de agente; el navegador nunca accede directamente a tablas de sesiones ni a SDP.

## 7. Controles de seguridad obligatorios

| Dominio | Control de diseño | Criterio verificable |
|---|---|---|
| Habilitación | `WHATSAPP_CALLING_ENABLED=false` por defecto; allowlist de `phone_number_id` y destinatarios | Sin flag y allowlist correctos, ninguna llamada puede iniciar |
| Agentes | Allowlist server-side de `user_id` para el piloto, además del rol `agent` | Un agente no autorizado recibe 403 sin solicitar micrófono ni llamar a Meta |
| Tenant | `account_id` derivado de sesión; `phone_number_id` mapeado a una sola cuenta | IDs de otra cuenta no permiten leer, reclamar ni señalizar llamadas |
| Consentimiento | Consultar permiso Meta en servidor; respetar revocación y expiración | Sin permiso válido, BIC no ejecuta `connect` |
| Claim | RPC atómico; una sola reclamación; no reclamar después de aceptación | Dos agentes simultáneos producen un único ganador |
| Micrófono | Claim antes de `getUserMedia`; audio deshabilitado hasta aceptar | El perdedor no recibe prompt ni abre micrófono |
| SDP | Cifrado en reposo, TTL corto, acceso solo al claimant/initiator | No hay SDP en logs, historial ni respuestas para otros agentes |
| Webhook | HMAC del raw body, secreto por tenant, durable inbox | Firma inválida 401; caída de DB/config 503 reintentable; no pérdida silenciosa |
| Idempotencia | Clave de evento, `request_id`, `call_id` y callback data | Duplicados/out-of-order no crean sesiones duplicadas ni regresan estado |
| Abuso | Rate limits por usuario, cuenta, número y destinatario; límites de concurrencia | Se bloquean ráfagas y llamadas paralelas no autorizadas |
| Secretos | Token Meta cifrado y descifrado server-side; App Secret por tenant; secretos TURN no públicos | No aparecen en bundles, logs, capturas ni respuestas API |
| Privacidad | Sin grabación/transcripción en CALL-04; logs sanitizados | Solo metadatos necesarios, con retención definida |
| Kill switch | Bloquea nuevas llamadas, pero permite terminar y reconciliar sesiones activas | Se puede detener el piloto sin dejar llamadas activas/huérfanas |

### 7.1 Límites y protección frente a llamadas no deseadas

Meta documenta para producción:

- Permiso temporal por 7 días; permiso permanente hasta que el usuario lo revoque.
- Máximo de 100 llamadas conectadas cada 24 horas por número empresarial.
- Máximo de 1 solicitud de permiso en 24 horas y 2 en 7 días.
- Dos llamadas BIC consecutivas no atendidas provocan un aviso al usuario; cuatro pueden revocar automáticamente el permiso.

WACRM debe fijar límites locales configurables por debajo de los máximos de Meta. Los valores concretos se aprobarán en CALL-04A y no se hardcodearán como un supuesto.

## 8. Fases de CALL-04

| Fase | Alcance | Cambios permitidos | Gate de salida |
|---|---|---|---|
| CALL-04A — Preflight | Auditoría de Meta, número, app, permisos, webhook, límites y settings | Solo lectura | Prerrequisitos documentados; sin cambios en Meta |
| CALL-04B — Hardening/QA | Claim antes de micrófono, mock de timestamps, prueba de red real en QA, rate limits y allowlist de agentes | Código/QA aislado; sin llamadas reales | CI/Migrations PASS, T1–T4 repetidos sobre código corregido |
| CALL-04C — Meta staging | Conectar un número público de prueba o entorno Meta dedicado, si está disponible; validar webhook firmado y llamadas de prueba | Solo configuración de staging autorizada | UIC/BIC verificados con Meta, permisos, audio, estados y duración |
| CALL-04D — Piloto real restringido | Activar un solo número y destinatario aprobado, con uno o pocos agentes allowlisted | Flags y settings de piloto con autorización explícita | Una llamada real controlada, atribución e historial correctos, cierre y rollback probados |
| CALL-04E — Ampliación | Aumentar agentes/contactos gradualmente | Allowlist incremental | Calidad, tasas de respuesta, errores y operación aceptables; autorización nueva |

El uso de un número de prueba/sandbox puede tener límites distintos a producción; los resultados de sandbox no deben usarse como evidencia de límites reales.

## 9. Observabilidad y operación

Registrar métricas sin SDP ni secretos:

- intentos BIC/UIC por estado y dirección;
- llamadas conectadas, rechazadas, no atendidas y fallidas;
- duración recibida de Meta y porcentaje de sesiones sin metadatos de duración;
- latencia de `connect`, `pre_accept`, `accept` y `terminate`;
- errores HTTP/Meta y códigos normalizados;
- firmas inválidas, cola durable, edad del evento más antiguo y reintentos;
- claims ganados/perdidos, leases expirados y sesiones huérfanas;
- fallos ICE, reconexiones y liberación de tracks;
- porcentaje de llamadas con atribución de agente y conversación completas.

Crear alertas para firma inválida sostenida, cola retrasada, errores de Meta, sesiones activas fuera de umbral, claims huérfanos y aumento de llamadas no atendidas/rechazadas.

## 10. Rollback

1. Activar el kill switch de nuevas llamadas y solicitudes de permiso.
2. Mantener el webhook `calls` firmado y el durable inbox activos mientras existan sesiones pendientes; no cortar primero la recepción de eventos terminales.
3. Permitir `terminate`, rechazo y reconciliación de llamadas activas, aunque el flag de nuevas llamadas esté apagado.
4. Esperar y verificar cero sesiones activas, cero claims, cero SDP efímero y cero intentos salientes inciertos sin reconciliar.
5. Solo después deshabilitar Calling en el número Meta y retirar la suscripción `calls` si la decisión de rollback lo exige.
6. Conservar historial, eventos, evidencia y backups; no borrar sesiones para ocultar fallos.
7. Revertir la app a la imagen estable anterior si el problema es de despliegue; no ejecutar rollback destructivo de datos.

**Requisito de implementación:** separar explícitamente los permisos para iniciar/aceptar nuevas llamadas de los permisos para finalizar y limpiar llamadas ya iniciadas. El kill switch no debe bloquear `terminate` ni la reconciliación.

## 11. Criterios de aceptación de CALL-04

- PRs CALL-01/02/03 integrados en orden; `main` con CI, Migrations y replay limpio PASS.
- H1/H2 de CALL-03 resueltos y probados; T3A real de QA registrado antes de ampliar el piloto.
- Meta preflight PASS: país/availability, messaging limit, permisos, Calling settings, call hours, webhook subscription, App permissions y SIP.
- Allowlist server-side de cuenta, número, destinatario y agente.
- BIC no inicia sin permiso vigente y cuota disponible.
- UIC no solicita micrófono antes de ganar claim; no acepta SDP expirado ni reproduce audio antes de HTTP 200 de `accept`.
- Webhook real validado con firma, durable inbox, deduplicación, retry y aislamiento multi-tenant.
- Una llamada real controlada tiene audio bidireccional, actor correcto, conversación correcta, estado terminal y duración Meta cuando fue atendida.
- No hay llamadas reales a destinatarios fuera del piloto; no hay mensajes de permiso enviados sin acción explícita.
- Rollback ensayado y cero sesiones/claims/SDP al cerrar la ventana de prueba.

## 12. Decisiones pendientes para CALL-04A

1. Confirmar país/código del número empresarial y su `phone_number_id`; esto determina disponibilidad BIC y elegibilidad de permisos.
2. Confirmar si la primera prueba real será BIC a un contacto con permiso vigente o UIC desde el teléfono del usuario. Recomendación inicial: BIC restringido a un destinatario autorizado, por ser más controlable; UIC se habilita después de decidir el control de llamadas entrantes no solicitadas.
3. Definir los `user_id` de uno o pocos agentes autorizados; no inferirlos de nombres ni de cuentas QA.
4. Confirmar horarios operativos y feriados, proponiendo zona `America/Lima` si corresponde.
5. Confirmar si existe un número Meta de prueba/staging para validar el contrato real antes de usar el número empresarial.
6. Definir límites locales de intentos, concurrencia, ventanas de operación y métricas de salida.
7. Decidir si la prueba real de red requiere TURN o si la conectividad STUN/ICE observada es suficiente.

## 13. Fuentes oficiales Meta revisadas

- Cloud API Calling, prerequisitos, disponibilidad y pruebas: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling
- Business-Initiated Calls, permisos, secuencia y webhooks: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls
- User-Initiated Calls, ventana de aceptación y orden `pre_accept`/`accept`: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls
- User Call Permissions, límites y expiración: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions
- Call Settings, habilitación, horario, iconos y permission mode: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings

**Estado final:** CALL-04 está diseñado, pero no implementado. No activar `calls`, no habilitar Calling en Meta, no enviar solicitudes de permiso ni realizar llamadas reales hasta que CALL-04A–D tengan autorización separada.
