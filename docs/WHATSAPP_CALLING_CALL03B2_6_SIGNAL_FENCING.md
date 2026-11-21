# WACRM — CALL-03B2.6: cierre de la carrera accept/pre_accept vs terminate

**Estado:** candidato en PR apilado sobre #144; no desplegado. Sin activación Meta ni cambios en la VPS.

## Problema que se corrige

CALL-03B2.5 introdujo reserva atómica de terminal antes del POST a Meta, pero la ruta `pre_accept` y `accept` todavía podía haber salido a Graph antes de que `terminate` tomara la reserva. Una verificación GET o una lectura no serializada no es suficiente.

## Solución

La migración aditiva `20261201000001_whatsapp_call_signal_fencing.sql` incorpora al registro de llamada un único estado persistente de señalización: `signal_request_id`, `signal_action`, `signal_status`, `signal_actor_user_id`, `signal_claimed_at`, `signal_reserved_at`, `signal_updated_at`.

Las RPCs `whatsapp_call_signal_begin` y `whatsapp_call_signal_finish` usan el bloqueo de la MISMA fila que `whatsapp_call_terminal_reserve`. No hay transacción abierta durante HTTP. Los dos resultados excluyentes son:

- **Signal gana:** `signal_begin` registra la reserva, luego Meta puede recibir `pre_accept`/`accept`. `terminate` ve `signal_status='reserved'` y devuelve `in_progress` sin llamar a Meta.
- **Terminal gana:** `terminal_reserve` registra la reserva, luego `signal_begin` devuelve `terminal_in_progress` y jamás envía señalización a Meta.

Al confirmar `pre_accept`, se registra `acknowledged`; **el mismo actor y el mismo epoch del claim** pueden avanzar a `accept`. Una repetición de `pre_accept` devuelve `already_acknowledged`, sin segundo envío. `accept` confirmado registra `accepted_by_user_id` en la misma transacción que su estado `acknowledged`, eliminando el intervalo con atribución pendiente. Después de esa confirmación, su propietario puede terminar la llamada.

Si Meta responde con excepción, timeout o resultado no verificable, el estado se conserva como `unknown` y la API retorna HTTP 202 **`success:false`**. No se reintenta automáticamente ninguna acción externa; las posteriores reservas quedan bloqueadas hasta conciliación autorizada. El Inbox interpreta ese 202 como señalización **no confirmada** y detiene el flujo local.

El claim, release, SDP store y expiración de ofertas se protegen frente a señales pendientes para no transferir una operación en vuelo al siguiente agente. `renew_claim` sigue disponible para el actor mientras exista el claim, salvo estado `unknown`.

## Qué cubren las pruebas

- `route.signaling.test.ts`: las dos intercalaciones A/B frente al mock de Meta, HTTP 409 sin envío cruzado, respuesta 202 `unknown`, aceptación de una llamada ya conectada sin duplicar Meta, atribución atómica comprobada por RPC.
- `verify-call03b2-6.sql`: permisos service_role, claim y epoch, `pre_accept` reservado, `accept` reservado, `terminate` bloqueado, confirmación y atribución, terminal primero, unknown inmutable, idempotencia.
- `verify-signal-terminal-concurrency.sh`: dos sesiones PostgreSQL reales sobre datos sintéticos, una compite por `pre_accept` y `terminate`, la otra por `accept` y `terminate`. En cada una solo puede persistir una reserva.

Los scripts SQL dejan la base de CI sin datos (transacción de rollback/limpieza en base efímera). No utilizar el script de carreras para una base QA/productiva.

## Riesgos y límites residuales

1. Dos pestañas del **mismo userId** siguen compartiendo claim sin UUID por pestaña; el epoch mitiga transferencias pero no aísla completamente dos pestañas concurrentes. Este riesgo requiere incremento independiente.
2. Webhook externo `connected`/`terminated` puede llegar mientras Meta responde. La RPC de finalización no sobreescribe un evento terminal; si la base ya está terminal, marca `unknown`. Se necesita reconciliación manual basada en Meta, sin reintentos automáticos.
3. Cualquier `signal_status='unknown'` es una inmovilización deliberada de seguridad: no limpiar por cron sin evidencia del resultado externo.
4. El callback de Graph es un mock en QA; los resultados no prueban la aceptación del API real ni autorizan activar el webhook `calls`.
5. No considerar una compilación o CI verde como prueba de QA Firefox. Necesitamos nuevas pruebas A/C en entorno aislado y verificación de 18 sesiones históricas.

## Secuencia controlada para QA (no ejecutar sin gate de escritura)

1. Revalidar HEAD/CI/Migrations del PR de señalización y todo el stack; registrar git SHA, migraciones previas 00004 y ausencia de 00005/00006.
2. Ensayo de restauración de dump QA previo en contenedor **efímero y aislado**, verificando tablas y hash histórico; no restaurar encima de la base actual.
3. Tomar respaldo nuevo de QA, verificar checksum y demostrar procedimiento de rollback **antes** de aplicar migraciones.
4. Aplicar **ambas** migraciones en secuencia `20261201000000` (terminal) y `20261201000001` (signal), solo en PostgreSQL QA. Nunca arrancar la nueva app sin ambas.
5. Ejecutar QA SQL/HMAC/WebRTC con Graph mock, imagen construida externamente usando el Environment `qa-call03b2`, puertos 127.0.0.1:38089/38090 y túnel SSH del navegador.
6. Verificar *antes y después* las 18 sesiones históricas con [`verify-call03b2-6-history-projection.sql`](../scripts/qa/whatsapp-calling/verify-call03b2-6-history-projection.sql), contrastando con `phase2b/hist.sql` original. **No comparar el MD5 sobre todas las columnas después de la migración**: `to_jsonb(s)` incluiría 13 columnas `terminal_*`/`signal_*` nuevas aunque todas estén NULL, alterando el hash. El script retira únicamente esas claves, usa el mismo orden y espera MD5 `2c0040780134cab5a7c807b6063ee090`. Si no coincide, bloquear y cotejar exactamente el SQL histórico antes de interpretar daño de datos. Mantener cero reclamaciones/SDP/reservas en sesiones sintéticas finalizadas.
7. Documentar incidencias y detenerse antes de cualquier merge productivo. No activar Meta `calls`.

## Dependencias

#142 → #143 → #144 → este incremento. El [PR #145](https://github.com/AlexisCasas/wacrm/pull/145) ya fusionó **solo** el workflow manual para generar una imagen QA aislada; no fusionó código Calling. No confundir un artefacto de Docker con un despliegue.
