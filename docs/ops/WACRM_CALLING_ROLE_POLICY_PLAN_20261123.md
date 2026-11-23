# WACRM — Cierre de WhatsApp Calling y política operativa de acceso (CALL-RBAC-01)

**Fecha:** 23 noviembre 2026, Lima.  
**Estado:** `PLAN_ONLY` — inventario y política propuesta, sin código funcional, migración, cambios Meta ni despliegue.  
**Cuenta piloto:** InkaClick / Keyler Ortega, Meta Phone Number ID `740434745820831`.  
**Baseline de producción informado por operador:** `wacrm-app:global-incoming-alert-9076c1c8` (Git SHA `9076c1c8e74bb8aee6b56558dd730d8ef901cf4e`).  
**Branch de referencia:** `ops/inkaclick-callback-permission-20261123` (PR #168), apilado sobre #167 y #164.

## 1. Hechos confirmados hasta el corte

| Hito | Evidencia / resultado | Estado |
|---|---|---|
| Calling API y UI, pilotos InkaClick | PR #164: corrigió identidad de quien llama (`USER_INITIATED` debe usar `call.from`), preserva BSUID y control de auto-llamada | Código desplegado |
| Llamada entrante con conversación seleccionada | Operador aceptó llamada de Ángelo desde WACRM y confirmó voz bidireccional | `INBOUND_AUDIO_E2E=PASS_REAL` |
| Notificación global entre conversaciones | PR #167 HEAD `9076c1c8`, alerta desde Alexis mientras Ángelo abierto, `Ver y contestar` abre chat correcto, aceptación y audio bidireccional | `CROSS_CHAT_CALL_QA=PASS_REAL` |
| Despliegue blue/green global | Imagen `wacrm-app:global-incoming-alert-9076c1c8`, Docker healthy, reinicios 0, Caddy/HTTPS 200, webhook errors 0; rollback conservado | `GLOBAL_ALERT_DEPLOY=PASS` |
| Llamada saliente con consentimiento | Alexis autorizó temporalmente hasta 29-nov y realizó llamada desde WACRM, móvil contestó, voz bidireccional | `OUTBOUND_AUDIO_E2E=PASS_REAL` |
| Meta permiso de devolución | PR #168 operativo, CI `45113775174` PASS; Meta `callback_permission_status` pasó `DISABLED` → `ENABLED`, POST ACK, GET independiente verifica | `CALLBACK_META_ENABLED=PASS` |
| Salud después de callback | `CALLBACK_POSTCHECK=PASS`; imagen healthy, Caddy upstream `wacrm-app-1:3000` PASS, HTTPS 200, readiness DB 200, webhook errors 0, restart 0 | PASS |
| Devolución a contacto sin permiso previo | Falta validar cómo aparece el consentimiento y una devolución real con un contacto sin permiso anterior | `CALLBACK_REAL_QA=PENDING` |
| Estado de PR | #164, #167, #168 abiertos en Draft y apilados (según consulta GitHub al redactar) | Merge formal PENDING |

**Distinción obligatoria:** `callback_permission_status=ENABLED` **no prueba** que cada cliente haya concedido un permiso; cada llamada saliente seguirá exigiendo permiso Meta vigente (`temporary` o `permanent`) y `canStartCall=true`. No automatizar solicitudes repetidas o llamadas a clientes sin permiso.

## 2. Requisito de negocio del próximo incremento

Solo usuarios cuya **área operativa** sea `logistics` (Logística) o `supervisor` (Supervisor) pueden manejar WhatsApp Calling: notificaciones entrantes, abrir oferta, claim, pre-accept, aceptar, rechazar, iniciar salientes, solicitar/revisar permisos de llamadas y controlar llamadas activas.

`commercial` (Comercial) y `NULL`/valor desconocido: **sin facultad de Calling**. Sin alterar permisos para conversaciones, mensajes, pedidos, Flows o cualquier otro módulo.

La captura de **Configuración → Miembros del equipo** muestra dos selectores distintos: **área operativa** (Supervisor/Logística/Comercial) y **rol técnico** (Propietario/Agente). En esa captura hay un propietario Supervisor, tres miembros Logística y tres miembros Comercial. Es evidencia visual puntual, **no** auditoría SQL del estado actual.

### Política de autorización recomendada (intersección, nunca unión)

- `account_role` debe ser `owner`, `admin` o `agent` (no `viewer`).
- **Y** `profiles.operational_role` de ese mismo usuario y cuenta debe ser exactamente `logistics` o `supervisor`.
- **Y** el número/cliente debe superar el piloto existente de InkaClick (`WHATSAPP_CALLING_ENABLED`, phone-number allowlist, auto-llamada prohibida, configuración de WhatsApp conectada).
- Ni `owner` ni `admin` tienen bypass automático del área operativa. Ej.: owner/Comercial = Calling DENIED; agent/Supervisor = Calling ALLOWED.
- El campo de área no depende de `logistics_mvp_enabled` para evaluar Calling: usar el valor vigente de `profiles.operational_role` y evitar vincular seguridad de llamadas a una feature flag de pedidos. No cambiar esa flag.
- Unknown, missing, cross-account, DB error y perfil no vinculado: **FAIL CLOSED**.
- El cliente jamás decide su propio permiso enviando `operational_role` en headers/body, localStorage, JWT user_metadata o parámetros.

| Rol técnico | Área operativa | Calling | Mensajes generales |
|---|---|---|---|
| owner / admin | supervisor | ALLOW | Sin cambios |
| owner / admin | logistics | ALLOW | Sin cambios |
| owner / admin | commercial, null | DENY | Sin cambios |
| agent | supervisor / logistics | ALLOW | Sin cambios |
| agent | commercial, null | DENY | Sin cambios |
| viewer | cualquiera | DENY | Solo lectura, igual que ahora |
| sin sesión / otra cuenta | cualquiera | DENY | Conforme a auth existente |

## 3. Hallazgos de código actuales (revisión read-only GitHub, HEAD PR #168)

1. `src/lib/auth/operational-role.ts` ya define `OperationalRole = "commercial" | "logistics" | "supervisor"`. Es un dato **independiente** de `account_role`; no concede capacidades por sí mismo.
2. `supabase/migrations/20261121000000_order_logistics_foundation.sql` introduce `profiles.operational_role` y su enum. La selección en Configuración usa `src/components/settings/members-tab.tsx`, endpoint `src/app/api/account/members/route.ts` y RPC `set_member_operational_role`. No hace falta crear otro campo/enum solo para Calling.
3. `src/hooks/use-auth.tsx` carga `account_role` pero NO selecciona `operational_role` al autenticar; `src/hooks/use-can.ts` solo tiene capacidades basadas en `account_role`.
4. `src/components/inbox/calling-panel.tsx` y `src/components/inbox/global-incoming-call-alert.tsx` usan `useCan("send-messages")`. Consecuencia: Comercial/Agente accede hoy a Calling. Ocultar controles no es un control de seguridad suficiente.
5. `src/app/api/whatsapp/calls/route.ts`: GET y POST usan `requireRole("agent")`, pero **no verifican el área operativa**. Hay rutas GET de elegibilidad de contacto, `inbox_alerts`, detalle SDP/historial; POST controla `claim`, `renew_claim`, `release`, `pre_accept`, `accept`, `reject`, `terminate`, `connect`, `check_permission`, `request_permission`. Este endpoint es el principal control obligatorio de servidor.
6. Las funciones RPC de Calling, según migraciones, revocan `EXECUTE` a `anon`/`authenticated` y lo conceden a `service_role`: hay que **confirmar ACL reales en la VPS** antes de decidir si la corrección requiere migración. No asumir que las migraciones del repositorio equivalen automáticamente a la BD instalada.
7. Webhook `calls`, reconciliación, conservación de historial/SDP y mecanismos Meta son servicios de backend, no acciones de agente. **No bloquear su ejecución** por roles operativos.
8. El permiso de devolución de Meta sigue `ENABLED`; no modificar `callback_permission_status` ni `call_permission_mode` para esta política.

## 4. Diseño de incremento CALL-RBAC-01 — propuesto para desarrollo posterior

### A. Política central única (pura + resolver servidor)
- Añadir función pura (ej. `canOperateWhatsAppCalling(accountRole, operationalRole)`) con matriz explícita, testeable, predeterminado DENY.
- Crear guard del servidor que obtenga el `userId` y `accountId` confiables de `requireRole("agent")`, luego lea **`profiles.operational_role` fresco desde BD y con scope account_id+user_id**, con `403 Forbidden` si no es `logistics` o `supervisor`. Cualquier fallo lectura = DENY (sin bypass por owner).
- Evaluar el guard **antes de leer SDP, listar alertas, consultar Meta o reservar claims**; no registrar teléfonos ni SDP en logs.

### B. Frontend
- Ampliar `use-auth.tsx` para traer `operational_role`, tiparlo y exponerlo de manera segura; añadir `useCan("use-calling")` que interseque `account_role` + área operativa.
- Reemplazar específicamente `useCan("send-messages")` por `useCan("use-calling")` en panel Calling y alerta global. NO cambiar `send-messages` general.
- Comercial, Viewer y sin área: cero botones Calling, permiso de llamada, historial/alertas de Calling, polling ni accesos intermedios; chat normal permanece usable.
- Revalidar al recargar/cambiar sesión; un `403` backend debe cerrar posibilidad de nuevas acciones y pedir actualización de permisos, sin ocultar un aviso de error crítico si una operación ya estaba en curso.

### C. Backend
- Autorizar **TODAS** las ramas GET/POST de `/api/whatsapp/calls`, con prueba explícita de que Comercial recibe 403 sin llamar a Meta ni leer SDP/call history.
- No bloquear webhooks, procesamiento de llamadas entrantes ni persistencia de historial para agentes elegibles.
- Evitar conceder permisos por ser `owner`/superuser salvo intersección con área operativa.
- Resolver casos de **cambio de área durante una llamada activa**: negar nuevos `claim/connect/accept/permission_request` inmediatamente; permitir solamente cleanup seguro (`release/terminate`) **por propietario original probado de esa llamada**, sin habilitar nuevos claims ni exponer SDP, de modo que la sesión no quede huérfana. Comprobar aislamiento y atribución. No hacer reintentos Meta cuando estado es incierto.
- Revisar RPC/ACL reales para que una persona con `authenticated` no pueda ejecutar directamente operaciones privilegiadas de Calling. Si alguna RPC está expuesta, crear migración correctiva mínima tras auditoría SQL; si no, no crear migraciones innecesarias.

### D. Tests y QA
- Función pura: matriz rol técnico × área operativa, nulo/desconocido/owner Comercial.
- API GET: `pilot_contact_id`, `inbox_alerts`, `call_id` y lista de historial: 403 para Comercial y Viewer; ALLOW para Supervisor/Logística.
- API POST: `check_permission`, `request_permission`, `claim`, `renew_claim`, `pre_accept`, `accept`, `reject`, `connect`: 403 para Comercial; no llamadas Meta/DB RPC de mutación.
- Concurrencia dos agentes, idempotencia, cambio de conversación, llamadas activas y limpieza por agente previamente autorizado pero recién degradado.
- UI: un agente de Logística recibe banner, acepta y escucha/habla; Supervisor inicia saliente **solo con permiso Meta válido**; Comercial no ve banner ni botón Llamar; puede enviar/leer mensajes y continuar Flows normalmente.
- Aislamiento: otras empresas Calling OFF; nunca volver a permitir auto-llamadas al número de InkaClick.
- Revisión de permisos cambios en caliente (democión/promoción), RLS y ausencia de secretos en logs.
- CI: lint, typecheck, test, build y overlay/dark-release PASS.

### E. Gates de salida
1. Preparar PR de implementación *separado del PR de planificación*, sin modificar los PR #164/#167/#168.
2. Auditoría read-only SQL de las ACL e integridad real de `profiles.operational_role` de InkaClick (solo conteos por rol, sin emails/identidades).
3. PR CI PASS, pruebas focalizadas y test de 2 usuarios reales con áreas diferentes en QA.
4. Plan de corte blue/green en VPS sobre imagen actual, checksum respaldo, flags piloto, `ACTIVE_CALLS=0`, dry-run PASS y rollback probado. **No cambiar Meta**.
5. Postdeploy: `403` real Comercial; alertas/aceptación y saliente autorizada para Logística/Supervisor; webhook 0 errores y Flow recovery PASS.
6. Documentar E2E, revisar PRs apilados para merge seguro y comprobar que integración a `main` **no sustituya la imagen viva por código obsoleto**.

## 5. Riesgos y decisiones explícitas

- **Owner Comercial:** DENY. Permitir bypass por rol técnico invalidaría la regla pedida.
- **Usuario sin área:** DENY, aunque técnicamente sea admin/agent. Administrador debe asignar área en Configuración.
- **Frontend no es barrera:** siempre comprobar en servidor; un usuario podría ejecutar `fetch('/api/whatsapp/calls')` directamente.
- **Cambio de área en llamada:** planificar cleanup del actor original; no cortar el audio arbitrariamente por una lectura stale del frontend. Una nueva llamada sí debe bloquearse.
- **Política por cuenta:** se aplica al piloto InkaClick sin activar Calling en otros números. Al ampliar el rollout, habrá que decidir si la matriz es global o una política por tenant; no expandir en este incremento.
- **Estado Meta:** callback `ENABLED`, pero falta una prueba con contacto sin autorización previa. Ese QA es independiente de CALL-RBAC-01 y no debe confundirse con un PASS de la nueva matriz.

## 6. Próxima decisión

Revisar esta matriz de acceso y autorizar expresamente el desarrollo de `CALL-RBAC-01`. Hasta esa autorización, **`CALL_RBAC_IMPLEMENTED=NO`, `CALL_RBAC_DEPLOYED=NO`, `PRODUCTION_CHANGED=NO`** por este documento.
