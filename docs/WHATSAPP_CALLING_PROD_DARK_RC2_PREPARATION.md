# WhatsApp Calling — RC2: preparación de integración definitiva (21-nov-2026)

**Estado:** `INTEGRATION_PREPARED` exclusivamente en rama de revisión, `PROD_DARK_DEPLOY=NO_GO_PENDING_PREFLIGHT`, `META_CALLING_LIVE=NOT_AUTHORIZED`.

## BLOQUEO CRÍTICO: producción diverge de main (PROD_BASELINE_DRIFT)

La última imagen productiva **reportada y verificada en QA por el operador** antes de este RC2 es `wacrm-app:p0-total-correction-300284e6` (SHA origen GitHub `300284e671aa358fc392273d639746f91c1e4219`; imagen `sha256:270792f2…`). **Ese commit NO es ancestro de `main` ni del RC2.** GitHub `compare` registra `300284e6 → main: ahead=2, behind=64, diverged`, y `300284e6 → RC2: ahead=395, behind=64, diverged`.

Diferencia base `main → prod` incluye cambios de pagos, pedidos, Shalom, controles operativos, traducciones y migraciones de producción (`20261205000005_supervised_order_total_correction.sql` entre ellas), que **no forman parte de este RC2**. No inferir que todos son funciones faltantes: una comparación de árboles/diffs y esquemas debe determinar las diferencias reales.

**Prioridad absoluta:** primero reconciliar producción → `main` mediante PR independiente con revisión y CI; luego reconstruir/actualizar el candidato Calling desde esa línea reconciliada. No reemplazar la imagen viva con RC2 actual: podría perder funcionalidad de pedidos y pagos ya desplegada.

Antes de cualquier merge o build productivo: reconfirmar la fuente/digest del contenedor `wacrm-app-1` y si la imagen viva cambió desde las 19:47Z; ante cambios posteriores, actualizar la base y repetir la auditoría. No hacer fast-forward forzado, `reset`, `push --force`, ni migraciones irreversibles como atajo.

**Gate:** `PROD_BASELINE_PARITY=BLOCKED` y `CALLING_DARK_RELEASE_GO=NO` hasta obtener diffs compatibles, migraciones ordenadas y SHA de integración definitivo.

## Decisiones aprobadas y límites

- Se autoriza la **preparación de integración** en GitHub. No equivale a permiso para merger, migrar Supabase productivo, desplegar Docker ni habilitar suscripción real de llamadas.
- Se **pospone la validación funcional con Meta real** hasta una fase de piloto **posterior** al despliegue con Calling apagado. Inyección artificial de errores 503, reconciliaciones mutantes y carreras deliberadas entre HTTP `accept`/`terminate` **no deben ejecutarse sobre clientes ni servicios productivos**. Mantener esos ensayos exclusivamente en QA/sandbox.
- Los riesgos funcionales de CALL-03B2.6 siguen abiertos: `RACE_NOT_EXECUTED`, 6 reservas `unknown` en **QA** y una sesión `offered` sin resolver, conciliación de webhook confirmatorio no implementada y evidencia HTTP 202 no capturada. Esto no es un PASS de QA.
- El piloto está restringido a un número empresarial y contacto definidos en `calling-pilot.ts`. **No asumir** que la allowlist sintética de QA es una habilitación general ni que se ha validado la identidad del piloto real; requerirá confirmación y autorización específicas sin exponer datos del cliente.

## Referencias y procedencia

- Código base de Calling: #134 → #136 → #137 → #138 → #140 → #142 → #143 → #144 → #146, acumulado en el candidato anterior PR #150 (cerrado sin merge, SHA `5b3bce53494c7c601f9545eb041bc0274ea2fdc9`).
- Este RC2 se crea sobre el candidato anterior e incorpora **defensa en profundidad**: `isWhatsAppCallingPhoneEnabled` en API/entrada de webhook de llamadas y procesamiento de permisos de llamada; tests de default-OFF y número empresarial exacto; guard estático de CI.
- Evidencia QA: PR #148, comentario #7068817460. T1 SQL/Graph PASS; T2 Graph no duplicado PASS; gate global `CALL03B26_QA_CLOSEOUT=NO_GO`.
- **Excluidos** PR #141 y #149 (simulador Graph/Peer/fault injection QA). No importar ninguno de sus Dockerfiles, YAML, fuentes ni variables de simulador en producción.
- En el corte de creación, `main=9178218d67d46ca2d37d50d57655d3484c8ef867`; el candidato previo estaba 389 commits ahead/2 behind. `main` incorporó `.github/workflows/wacrm-qa-candidate-image.yml`, flujo independiente exclusivamente QA que debe conservarse al fusionar. No reescribir historia, no resetear ni forzar `main`.

## Contrato fail-closed para dark deployment

| Superficie | Debe ocurrir con Calling OFF | Gate |
|---|---|---|
| `POST /api/whatsapp/calls` | Denegar acciones Calling si bandera/allowlist no coinciden | Tests piloto y rutas, CI |
| Entrada `change.field='calls'` | Saltar sin persistir llamadas ni procesar SDP/Graph cuando bandera OFF o número empresarial no autorizado | Nuevo gate `isWhatsAppCallingPhoneEnabled` + tests |
| Respuesta de permisos de llamadas en `messages` | No escribir estado de permisos Calling cuando bandera OFF/número no autorizado; continuar el mensaje normal | Guard de webhook + regresión de mensajes |
| `messages` y flujos normales | Seguir procesando tal como en producción | Smoke regresión tras despliegue |
| Meta `calls` webhook | Continuar **OFF** | Verificación manual Meta; script CI NO verifica configuración remota |
| Meta `messages` webhook | Continuar **ON** | Verificación manual y prueba funcional de recepción |
| `MOCK_FAULT_INJECTION_ENABLED` / Peer QA | Nunca estar en imagen/Compose/entorno productivos | Revisión diff + guard estático |
| `WHATSAPP_CALLING_ENABLED` productivo | **false o ausente**; comprobar sobre configuración efectiva y contenedor candidato sin imprimir variables | Preflight VPS + postdeploy |

**Advertencia:** los tests unitarios y el CI estático no verifican por sí mismos la configuración real de Meta, los flags del contenedor ni el bloqueo de red. Un `CI=PASS` no autoriza activar llamadas.

## Gates antes de autorizar el merge final

1. **INT-01 (diff):** Revisar archivos de Calling/UI/webhook, 8 migraciones, RLS/ACL y dependencies; excluir mock QA y scripts de inyección. Auditar cambio de webhook para que no interrumpa mensajes normales.
2. **INT-02 (historia):** Integrar los dos commits faltantes de `main` mediante un merge/rebase convencional, sin perder workflow QA ni cambios de producción; revisar diferencias y resolver conflictos antes de cualquier merge.
3. **INT-03 (CI):** Ejecutar y exigir `CI=PASS`, `Migrations=PASS`, guard estático y tests sobre el **SHA definitivo ya sincronizado**. No heredar PASS de otra rama/SHA.
4. **INT-04 (autorización):** Autorizar expresamente fusión final a `main`. Si un push a `main` desencadena autodeploy, pausar y verificar política de despliegue previamente; no fusionar hasta garantizar que no activa Calling.

## Gates antes de un eventual dark deploy productivo

1. **PROD-01 preflight read-only.** Verificar imagen **actual** `wacrm-app-1`, tag/digest/health, uptime, baseline exacto antes de cada cambio (referencia histórica: `p0-total-correction-300284e6`, digest `sha256:270792f2...` el 21-nov 19:47Z); no asumir imagen antigua ni revertir despliegues ajenos. Verificar cron dependientes del nombre del contenedor, Caddy, DB, red, colas y mensaje en producción.
2. **PROD-02 backup/restore.** Respaldo fresco consistente de BD de producción y globals/config/image/Compose, SHA256 validado y ensayo de restauración en instancia **aislada** (nunca sobre BD productiva). Conservar release anterior y plan rollback probado. El restore-test QA omitido no basta.
3. **PROD-03 ocho migraciones.** Auditar SQL, dependencias/ACL y tiempos sobre una restauración de producción. Aplicar una sola vez, en orden y solo tras aprobación expresa separada; no ejecutar en QA ni en Supabase Cloud equivocado. Confirmar compatibilidad con código anterior para rollback no destructivo.
4. **PROD-04 artefacto.** Compilar imagen nueva de SHA aprobado, con parámetros `NEXT_PUBLIC_*` exclusivamente productivos, comprobar etiqueta OCI/revisión/digest. No reutilizar imagen de QA ni `wacrm-qa-candidate-image.yml` (solo exporta artefactos QA).
5. **PROD-05 dry-run.** `ops/deploy/deploy.sh <imagen>` **sin `--execute`** para probar overlays y readiness, mientras Calling flag OFF. Solo tras gates y autorización explícita ejecutar `ops/deploy/deploy.sh --execute <imagen>`.
6. **PROD-06 postdeploy OFF.** Verificar health, 502, mensajes inbound/outbound, templates, flows, autoría, BSUID, campañas, Inbox, cron, Caddy, permisos, colas y logs (sin datos de clientes). Confirmar `WHATSAPP_CALLING_ENABLED=false`, `calls` webhook OFF y `messages` ON. Mantener observación y rollback; si regresiones, detener promoción/rollback según procedimiento auditado.

## Activación piloto real separada: no implícita

Solo tras publicación dark PASS y nueva autorización:
- Confirmar número empresarial y contacto **reales** que integrarán el piloto, permisos Meta Calling, WebRTC/STUN/TURN, HMAC y la identidad asociada (nunca adivinar a partir de fixtures QA).
- Resolver de forma segura la reconciliación de eventos confirmados `unknown` y la caducidad de ofertas; ningún retry a Graph sin confirmación.
- Probar carrera HTTP determinista en QA/sandbox; **no provocar races ni fallos 503 artificiales contra tráfico real**.
- Cambiar bandera, allowlists y webhook `calls` solo para el piloto autorizado, con ventana, métricas, kill switch, verificación de audio bidireccional, permisos/denegación, rechazo, desconexión, historial y una ruta rápida de desactivación. Consentimiento y pruebas sin clientes externos no autorizados.
- La habilitación general multi-tenant queda fuera de este RC2.

## Estado documental del release

| Gate | Estado al crear RC2 |
|---|---|
| QA T1/T2 no duplicados | PASS de control; HTTP 202 directo pendiente |
| QA race `accept`/`terminate` | PENDING (no ejecutar en tráfico real) |
| QA reconciliación 6 unknown + offered | PENDING; fixtures SOLO QA |
| INT diff + CI de nuevo SHA | PENDING, ejecutar en PR |
| Convergencia con `main` y producción viva | BLOCKED (producción 64 commits por delante de main; RC2 no incorpora sus cambios) |
| Preflight + restore de producción | PENDING |
| Merge a `main` | NOT_AUTHORIZED |
| Migraciones productivas / Docker deploy | NOT_AUTHORIZED |
| Llamadas Meta reales | NOT_AUTHORIZED |

**Conclusión:** RC2 listo para revisión y preparación; ningún entorno productivo se modifica con estos archivos. `PREPARE=YES`, `DARK_DEPLOY_EXECUTE=NO`, `META_LIVE_ACTIVATE=NO`.
