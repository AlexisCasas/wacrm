# CALL-03B2.5 — Reserva atómica de cierre de llamadas

**Estado:** implementación en rama separada, sin despliegue ni aplicación de migraciones a QA/producción. **Base:** PR #143, HEAD `90bd9a0c`.

## Riesgo corregido

Antes de este incremento, la API validaba el último reclamante, llamaba a Meta y recién después registraba `ended_by_user_id`. Entre la lectura de propiedad y el POST externo, otro agente podía adquirir la llamada. La consulta GET del componente nunca constituye una garantía atómica.

## Contrato nuevo

1. La ruta valida sesión, cuenta, teléfono, allowlist, configuración y token antes de reservar.
2. Genera un UUID del intento y llama `whatsapp_call_terminal_reserve` con la identidad **derivada de la sesión**, la acción (`terminate` o `reject`), el contexto y, para limpieza UIC, el `claimed_at` textual original.
3. La RPC bloquea la fila (`FOR UPDATE`), comprueba cuenta, actor, estado y claim, y **graba una reserva permanente** antes del POST a Meta. La RPC `whatsapp_call_claim` y el `release` no pueden alterar una llamada reservada.
4. Un segundo intento responde `in_progress` (409) y **nunca vuelve a llamar a Meta**, aunque se use un nuevo request ID.
5. Ante confirmación de Meta, se marca `acknowledged` y luego se registra la atribución. Ante excepción, timeout o respuesta incierta de Meta, se marca `unknown` y se responde 202 **sin asumir éxito**.
6. Las reservas `reserved`, `acknowledged` y `unknown` no caducan automáticamente. Solo una conciliación confiable o un webhook terminal confirma el resultado y los operadores investigan estados bloqueados. El historial conserva el estado Meta como fuente autoritativa.

## Contextos permitidos

- `owned_call`: llamada saliente iniciada por el agente o entrante ya aceptada por él.
- `claim_cleanup`: llamada entrante no aceptada, claim vigente del propio agente **y marca `claimed_at` coincidente**. No existe excepción automática para owner/admin.
- `admin_override`: solo acción explícita de owner/admin; jamás permite interrumpir una UIC no aceptada que esté reclamada por otro agente.
- `reject`: solo UIC `offered/ringing`, sin aceptación previa ni claim activo de un agente diferente.

El token `claim_epoch` corresponde al timestamp textual `claimed_at` obtenido de GET, sin truncarlo a milisegundos en JavaScript. Esta comprobación es adicional a la identidad del actor y protege contra un cambio de claim. **No reemplaza un token UUID único por pestaña**: dos pestañas del mismo agente siguen siendo deuda técnica.

## Privilegios y aislamiento

Las dos RPC nuevas usan `SECURITY INVOKER` y solo se conceden a `service_role`; se revoca `EXECUTE` de `PUBLIC`, `anon` y `authenticated`. La tabla sigue con RLS. La API ignora cualquier `account_id` o `actor_user_id` del cuerpo y obtiene esos valores de la sesión. No se imprimen tokens, SDP ni identificadores privados en logs de errores.

## Resultados inciertos y operaciones de soporte

No hay reintento automático de Graph. **Nunca** se desbloquea un estado `unknown` solo porque transcurrió tiempo: Meta puede haber ejecutado la acción y perdido la confirmación HTTP. Para resolverlo deberá verificarse el evento `calls/terminate` firmado o utilizarse un procedimiento operativo auditado, fuera de este incremento. No habilitar una acción administrativa que borre reservas sin evidencia.

## Verificación

- `scripts/qa/whatsapp-calling/verify-call03b2-5.sql`: rol/RPC, transferencia A→B, reserva contra claim y release, rechazo, tenant, llamada saliente, resultado incierto e idempotencia. Fixtures sintéticos revertidos.
- Tests API en `route.signaling.test.ts`: reserva antes del POST Meta, 409 a duplicados/stale, timeout Meta 202 y estado unknown, fail-closed si falla SQL.
- CI/Migrations debe verificar el replay limpio y la regresión. Después es obligatorio QA con PostgreSQL aislado y concurrencia A/B real; no basta con mocks.

## Límites pendientes

- La llamada `accept` también tiene un side effect externo; su interacción con una finalización simultánea debe probarse específicamente. La ruta `pre_accept` y la función de almacenamiento SDP quedan bloqueadas ante una reserva, pero una solicitud ya en vuelo puede terminar después.
- `admin_override` requiere auditoría y autorización operativa antes de exponerse en la UI.
- `getUserMedia` sigue siendo una promesa del navegador que no puede cancelarse directamente.
- No realizar merge, despliegue, migraciones en VPS/Supabase Cloud ni activación Meta sin gate independiente.