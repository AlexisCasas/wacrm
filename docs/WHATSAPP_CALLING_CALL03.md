# CALL-03 — Inbox UI, WebRTC y ciclo de vida de llamadas

**Estado:** CALL-03A implementado y validado; CI #274 y Migrations #168 en PASS. PR #137 permanece Draft y apilado sobre CALL-02.  
**Dependencia:** CALL-02 (#136), cuyo gate técnico CI #252 + Migrations #147 está en PASS sobre `f4e26fe1cca3122d664e6ef0fbfd14ef0346b039`. CALL-01 (#134) y CALL-02 siguen sin merge; esta rama se apila sobre el HEAD CALL-02 y su PR debe apuntar inicialmente a `feat/whatsapp-calling-call02-20261119`.  
**Piloto futuro:** solo Keyler Ortega, teléfono `+51 980 942 247`, Phone Number ID `740434745820831`.

## 1. Guardas operativas no negociables

- Meta webhook `calls`: **desactivado**. `messages`: **activado**.
- No activar llamadas reales ni ejecutar acciones de Calling API durante desarrollo/QA automatizado.
- No modificar VPS, Supabase Cloud, secretos, variables de entorno ni configuración Meta.
- No crear ni desplegar migraciones en Supabase Cloud.
- No habilitar flags de llamadas. Cualquier futura habilitación pertenece a CALL-04 y requiere autorización explícita.
- La limitación del piloto debe ser una allowlist de servidor por cuenta/Phone Number ID; nunca confiar en un teléfono o `account_id` enviado por el navegador.

## 2. Hallazgos de arquitectura que CALL-03 debe resolver

1. CALL-02 persiste sesiones, eventos, permisos y reservas, pero todavía no implementa acciones de señalización desde la API autenticada.
2. El esquema CALL-02 no relaciona una sesión de llamada con `conversation_id`, ni conserva el agente que inició, aceptó o terminó la llamada. CALL-03 requiere migración aditiva para esos metadatos e índices, sin modificar migraciones históricas.
3. El endpoint actual de detalle descifra SDP al agente con claim vigente; CALL-03 debe completar el contrato de señalización y evitar devolver SDP a otro agente.
4. El lease actual es de 90 segundos y solo se renueva al reclamar. Una llamada activa necesita heartbeat/renovación y liberación en todos los caminos terminales.
5. `useRealtime` actual publica cambios de mensajes y conversaciones, no de llamadas. Se requiere un canal específico o polling con backoff y reconciliación al reconectar/volver a la pestaña.
6. El parser de webhook de CALL-02 procesa eventos `connect` y `terminate` y estados. Mantener el webhook `calls` apagado hasta completar CALL-03 y CALL-04.

## 3. Secuencia de implementación

### CALL-03A — Contrato backend y metadatos
- [x] Migración aditiva con `contact_id`, `conversation_id`, agentes iniciador/aceptante/rechazante/finalizador y `biz_opaque_callback_data`.
- [x] Trigger de integridad: la conversación y el contacto deben pertenecer al tenant de la llamada y la identidad telefónica/BSUID debe coincidir.
- [x] RPC atómico de atribución de agente y enlace a conversación; aceptación exige claim vigente, rechazo no puede robar una llamada reclamada por otro agente y finalización exige ownership o owner/admin.
- [x] RPC de renovación de lease de 90 segundos; un lease vencido no puede resucitarse.
- [x] API autenticada: `POST renew_claim` y `POST agent_action`; GET de lista/detalle expone IDs de conversación y agentes, nunca SDP cifrado ni datos opacos.
- [x] QA SQL de permisos/grants, atribución, rechazo, iniciador saliente, renovación/expiración de lease, aislamiento tenant y mismatch de contacto.
- [ ] Señalización Meta `connect`, `pre_accept`, `accept`, `reject`, `terminate` y correlación de intentos: siguiente subincremento CALL-03B.
- Antes de `connect`: consultar permisos y cuotas autoritativas de Meta; bloquear salvo permiso temporal vigente o permanente y `start_call` permitido.
- SDP nunca en logs, analítica, errores públicos ni mensajes. Tokens nunca llegan al cliente.

### CALL-03B — Cliente WebRTC
- Wrapper aislado sobre `RTCPeerConnection`; solicitar micrófono solo tras acción explícita del agente.
- Crear offer/answer según dirección y contrato Meta; aplicar remote description, ICE y tracks de audio según la especificación vigente.
- No añadir TURN/STUN de terceros ni credenciales externas sin decisión de arquitectura; evaluar conectividad real en QA de navegador.
- Liberar `MediaStreamTrack`, cerrar peer connection y limpiar listeners/timers al terminar, cambiar de conversación o desmontar.
- Manejar `getUserMedia` denegado, dispositivo ausente, dispositivo ocupado, navegador no compatible, ICE failed/disconnected, timeout y pestaña suspendida.
- Recuperación con límites y backoff; nunca iniciar una segunda llamada automáticamente ni repetir acciones Meta no idempotentes.

### CALL-03C — UI del Inbox
- Botón de llamada saliente en conversación, deshabilitado por defecto si el gate no está habilitado.
- Panel de llamadas entrantes con identidad, estado, tiempo transcurrido y agente que la atiende.
- Aceptar/rechazar y finalizar; claim atómico antes de aceptar.
- Solicitud de permiso de llamada en contexto de conversación, estado de permiso y resultado de aceptación/rechazo.
- Indicador claro de micrófono, dispositivo y permisos del navegador; no abrir el micrófono al cargar el Inbox.
- Estados visibles: solicitando permiso, llamando, entrante, conectando, conectada, reconectando, finalizada, rechazada y fallida.
- Historial con dirección, contacto, agente, duración, estado y fecha; filtrar por cuenta en servidor.
- UI accesible, responsive y localizada en `messages/es.json`, `messages/en.json` y `messages/ko.json`.

### CALL-03D — QA automatizado y de navegador
- Pruebas unitarias de máquina de estados y validación SDP.
- API: rol, aislamiento tenant, contacto/conversación cruzados, allowlist piloto, permiso ausente/expirado, cuotas Meta, claim conflictivo, heartbeat y terminal idempotente.
- WebRTC con mocks de `RTCPeerConnection`, `getUserMedia`, tracks, ICE, errores y cleanup.
- Pruebas de reconexión, polling/realtime duplicado, navegación entre conversaciones y doble clic.
- Pruebas UI para llamadas entrantes, permisos, estados, historial, accesibilidad y responsive.
- CI completo: lint, typecheck, suite, build y migrations replay limpio + SQL CALL-03.
- QA manual de navegador con dispositivos simulados; prueba de micrófono real solo después de la autorización específica, sin conectar con Meta ni llamar a un cliente.

## 4. Diseño de seguridad

- Toda autoridad se deriva de `requireRole('agent')`, sesión autenticada y configuración WhatsApp del tenant.
- Nunca aceptar `phone_number_id`, `account_id`, destinatario o rol como autoridad desde el cliente.
- Correlación saliente con `biz_opaque_callback_data` aleatorio, no con datos personales.
- Rechazar llamadas fuera del piloto en servidor, incluso si se manipula la UI.
- SDP cifrado solo si debe persistirse para handoff/reintento, con TTL corto y acceso limitado al agente dueño del lease.
- Evitar que el detalle de llamada exponga SDP, token, app secret, payload Meta o identidad de otro tenant.
- La llamada no se debe aceptar hasta que el agente gane el claim; las transiciones deben ser atómicas y resistentes a eventos fuera de orden.

## 5. Gates de salida

| Gate | Condición |
|---|---|
| G0 | CALL-02 CI #252 y Migrations #147 PASS (cumplido en el HEAD indicado) |
| G1 | CALL-01 integrado y CALL-02 integrado en orden, con diff apilado limpio |
| G2 | Migración aditiva y API CALL-03 con aislamiento, autorización y concurrencia PASS |
| G3 | Cliente WebRTC y UI Inbox con suites automatizadas PASS |
| G4 | Build de producción y preview Vercel verificado; sin llamadas reales |
| G5 | CALL-04: autorización operativa, activación de webhook `calls` y piloto controlado Keyler |

## 6. Vercel

El desarrollo se realizará en la rama y se validará con GitHub Actions. El conector Vercel disponible no muestra actualmente un proyecto `wacrm` en la cuenta conectada; no se debe crear un proyecto nuevo ni desplegar a producción por inferencia. Antes del preview hay que confirmar el proyecto Vercel correcto y su vínculo Git.

## 7. Criterio de cierre

CALL-03 no se considera terminado por tener botones visibles. Debe existir un ciclo completo de señalización y WebRTC probado en navegador, audio bidireccional, limpieza de recursos, recuperación de desconexión, atribución de agente, historial persistente y gates de seguridad aprobados. CALL-03 termina en preview/QA; activación real pertenece a CALL-04.


## 8. Avance implementado — CALL-03A

**Archivos añadidos**
- `supabase/migrations/20261130000000_whatsapp_calling_agent_attribution.sql`
- `scripts/qa/whatsapp-calling/verify-call03.sql`
- `src/app/api/whatsapp/calls/route.test.ts`

**Archivos ampliados**
- `src/app/api/whatsapp/calls/route.ts`: atribución de agente, enlace opcional a conversación y renovación de lease.
- `.github/workflows/migrations.yml`: ejecuta la nueva verificación CALL-03A tras el replay limpio.
- Este documento.

**No realizado:** ninguna migración en Supabase Cloud, despliegue Vercel/VPS, cambio en Meta, activación del webhook `calls`, solicitud de micrófono ni llamada real.

**Validación final CALL-03A — HEAD `10c2a337c5a475ba79a6b36aadda87a65e4158a1`**
- CI #274: **PASS** — Lint, Typecheck, Tests y Build.
- Migrations #168: **PASS** — replay limpio, CALL-02, concurrencia, CALL-03A, webhook durable/RLS, BSUID y controles de eliminación.
- La revisión detectó y corrigió dos riesgos antes del PASS: condiciones SQL con valores NULL que no cerraban el acceso a agentes sin ownership y un delimitador PL/pgSQL mal cerrado. La suite SQL ahora comprueba ambos casos, así como el bloqueo de reclamos tras rechazo/finalización.
- Sin llamadas reales, micrófono, Meta, VPS, Supabase Cloud ni despliegue.

**Resultado:** `CALL03A_QA=PASS`. PR #137 continúa Draft; no se fusiona ni se despliega hasta integrar CALL-01 y CALL-02 en orden y recibir autorización. El siguiente subincremento será CALL-03B (señalización y cliente WebRTC).
