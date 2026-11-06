# PR-A — Estados de WhatsApp: aislamiento por cuenta y transiciones monotónicas

Seguimiento de `docs/ops/WHATSAPP-WEBHOOK-RELIABILITY-20261106.md` (PR #80, hallazgo **H2**). **No** toca la recepción durable (H1 / PR-B) ni el despliegue sin interrupción (H3 / PR-C).
Línea base: `main` en `5d3dae2a`. Datos de prueba 100 % sintéticos; ningún mensaje real, ninguna llamada a Meta, ninguna base productiva.

## 1. Diagnóstico

`handleStatusUpdate()` (en `src/app/api/whatsapp/webhook/route.ts`) hacía, para cada estado de Meta:

```ts
.from('messages').update({ status: status.status }).eq('message_id', status.id)      // sin cuenta, sin orden
.from('broadcast_recipients').select(...).eq('whatsapp_message_id', status.id)          // leer y luego escribir
.from('messages').select(...).eq('message_id', status.id).limit(1)                      // para decidir a quién notificar
```

Esquema relevante: `messages.message_id` solo tiene un índice **no único**; la unicidad es `(conversation_id, message_id)` (migración 037). `whatsapp_config.phone_number_id` es único y es lo que la rama de mensajes entrantes ya usa para atribuir la cuenta. La rama de estados nunca la usaba.

| # | Defecto confirmado | Efecto |
|---|---|---|
| D1 | `UPDATE … WHERE message_id = X` sin ámbito de cuenta | Un `message_id` repetido en dos cuentas actualiza **las filas de ambas** |
| D2 | La notificación sale de `… .limit(1)` sin `ORDER BY` ni cuenta | Se notifica a una cuenta arbitraria, posiblemente **ajena** |
| D3 | La actualización de `messages` no tiene regla de orden | Una reentrega vieja hace **retroceder** `read → delivered → sent`; `failed` se sobrescribe y puede sobrescribir `delivered/read` |
| D4 | Se notifica cada evento, aunque no cambie nada o la escritura haya fallado | Notificaciones duplicadas y notificación de un estado que no se guardó |
| D5 | Meta envía `played` (nota de voz reproducida) y la columna no lo admite (CHECK 23514) | En producción: **21 errores en 6 h**, todos `played` sobre audios; la lectura nunca se refleja |
| D6 | Destinatarios de broadcast: se busca por `whatsapp_message_id` sin cuenta, y la regla de orden es *leer y luego escribir* | Escritura cruzada posible y carrera entre workers |
| D7 | Un status puede reescribir un mensaje **entrante** (de cliente) que comparta el id | Datos de cliente alterados |
| D8 | Se registra el objeto de error completo, cuyo `details` repite la fila (texto, URLs) | Datos de clientes en los logs |
| D9 | `new Date(parseInt(ts)*1000).toISOString()` lanza `RangeError` con una marca de tiempo mal formada | Aborta todo el lote de estados |

D1/D2/D6/D7 son riesgos **potenciales** en producción (no se ha observado una colisión real; no se miró ningún dato de clientes): la prueba usa colisiones sintéticas.

## 2. Reproducción (fase roja, sobre `main`)

`route.status.integration.test.ts` ejecuta el **handler real** con firma HMAC válida contra un Postgres y un PostgREST aislados (11 casos). Sobre `main`: **9 fallan y 2 pasan** (los 2 son controles: número desconocido y avance normal).

| Caso | Resultado observado en `main` |
|---|---|
| S1/S2 colisión entre cuentas | la fila de la otra cuenta pasa a `delivered`/`read`; se notifica a la cuenta equivocada |
| S4 `read → delivered → sent` | queda en `sent` y se emiten 3 notificaciones |
| S5 misma entrega ×3 | 3 notificaciones |
| S7 `failed` y eventos tardíos | termina en `sent`; `failed` sobrescribe `delivered`/`read` |
| S8 `played` | error 23514, el estado no cambia |
| S9 `deleted` | se notifica un estado que no se guardó |
| S10 mensaje de cliente | reescrito |
| S11 broadcast | el destinatario de una cuenta lo actualiza el número de otra |

## 3. Solución

**a) Atribución.** Igual que los mensajes entrantes: la cuenta es la dueña de `value.metadata.phone_number_id` del payload **ya verificado** (la firma se valida por unidad de enrutamiento: ese id solo se acepta con el secreto de esa configuración, o con el secreto global de Meta si la cuenta no tiene uno propio). Cero filas o más de una → no se escribe ni se notifica nada y se registra por qué (sin identificadores de clientes).

**b) Escritura.** Una sola llamada `apply_whatsapp_message_status(p_account_id, p_wamid, p_status, p_event_at)` (migración `20261108000000`), en **una transacción**:
1. destinatario del broadcast, alcanzado solo a través de un `broadcast` de esa cuenta;
2. filas de `messages` de esa cuenta (a través de su `conversation`), **solo salientes**, bloqueadas en orden de clave primaria con `FOR UPDATE` (el predicado se reevalúa con la última versión confirmada, así que dos workers no se pisan);
3. devuelve **solo las filas que cambiaron realmente**; el código notifica únicamente por ellas y siempre sobre la cuenta resuelta.

**c) Transiciones** (`whatsapp_status_can_advance`):

| Estado actual ↓ / evento → | sent | delivered | read | failed |
|---|---|---|---|---|
| `pending` / `sending` | ✓ | ✓ | ✓ | ✓ |
| `sent` | – | ✓ | ✓ | ✓ |
| `delivered` | – | – | ✓ | – |
| `read` | – | – | – | – |
| `failed` (terminal) | – | – | – | – |
| `replied` (solo destinatarios de broadcast) | – | – | – | – |

`played` se guarda como `read`. Valores que la app no guarda (`deleted`, …) se ignoran con un aviso acotado.

**d) Privilegios mínimos.** Las tres funciones son `SECURITY INVOKER` con `search_path` fijo, y `EXECUTE` solo para `service_role` (revocado a `PUBLIC`, `anon` y `authenticated`). No cambia ninguna tabla, columna, índice, política ni dato.

**e) Higiene.** Los errores se registran solo con `code`, `message` y una referencia hash del id (sin `details`); la marca de tiempo malformada ya no lanza.

**Único cambio observable del contrato público** (`message.status_updated`): se emite solo por cambios **efectivos y en orden**, con el estado **guardado** (un `played` llega como `read`). Hoy no hay endpoints de webhooks salientes configurados en producción (`webhook_endpoints`: 0).

## 4. Evidencia de QA (entorno aislado)

| Prueba | Resultado |
|---|---|
| Reproducción E2E de la ruta, sobre `main` | **9 fallan / 2 pasan** (fase roja) |
| El mismo E2E con el correctivo | **11/11** |
| SQL aislado (`message-status.integration.test.ts`): tabla de verdad de 28 pares, `played`, ámbito, entrantes, filas múltiples, broadcast, validación de argumentos, privilegios por rol | **11/11** |
| Concurrencia: ~210 llamadas barajadas por 10 mensajes (`sending → read`) y 12 carreras `failed` frente a `delivered/read` | cadena de cambios efectivos estrictamente creciente, sin pérdidas ni dobles aplicaciones |
| **Mutación**: sustituir la función por una versión *leer y luego escribir* | Q8 y Q9 **fallan** (4 cambios efectivos > 3; `failed` y `delivered` aplicados a la vez); con la función real pasan |
| Unitarias nuevas (ruta con mocks + utilidades) | 18/18; **11 de 12 de la ruta fallan** sobre el `route.ts` de `main` |
| Suite completa | **3719 pasan / 0 fallan / 170 omitidas** frente a 3701 / 0 / 148 en `main`; los 3700 tests que pasaban en `main` siguen pasando |
| Lint / typecheck / build con variables sintéticas | 0 errores / 0 errores / OK |
| E2E de regresión (77 migraciones, orden de producción y alfabético) | contactos SQL ×3 PASS · pedidos 16/16 · sondas InkaClick 13/13 y 7/7 |
| Regresión por áreas (misma comparación test a test) | Flows 836 · Mensajes/WhatsApp/webhook 803 (+18 nuevos) · Broadcasts 49 · Pedidos 176 · Automatizaciones/IA 452 · Contactos 285 — sin diferencias frente a `main` |
| Plan de ejecución con 1,4 M de mensajes | `idx_messages_message_id`, 0,9 ms; 0,45 ms de media por llamada |
| **Compatibilidad de rollback** | el `route.ts` de `main` contra la base ya migrada: resultado idéntico, prueba por prueba, al anterior a la migración |

Tres pruebas de `route.bsuid.test.ts` ejercitaban el camino antiguo (mensaje sin conversación; retención en piloto). Se mantienen con la misma intención: la base en memoria espeja ahora la función SQL (como ya hacía con `bsuid_flow_scope`) y el fixture de la primera prueba incluye la conversación de la cuenta.

## 5. Despliegue (no ejecutado; requiere aprobación aparte)

Orden obligatorio: **migración → comprobación → imagen**.

1. Copia de seguridad habitual (la migración no cambia datos, pero se hace igual).
2. Aplicar a mano, como `postgres`: `psql -v ON_ERROR_STOP=1 -1 -f supabase/migrations/20261108000000_whatsapp_message_status_apply.sql`. Es idempotente (`CREATE OR REPLACE`), con `lock_timeout` de 5 s.
3. Comprobar: las 3 funciones existen, `prosecdef = false`, `EXECUTE` solo para `service_role`; y que PostgREST las ve (el event trigger `pgrst_ddl_watch` de producción recarga la caché; verificación inocua: llamar a la RPC con un `p_account_id` aleatorio debe devolver `[]`, **no** `PGRST202`).
4. Cambiar la imagen. Recrear `app` sigue produciendo la ventana de ~10 s de 502 descrita en H3: hacerlo en una hora de poco tráfico y justo después del cron de pedidos.
5. Postchecks: desaparece `Error updating message status` (los `played`); aparece, como mucho, `[webhook] status event not applied` / `Error applying message status` si algo está mal; los estados avanzan; la tasa de `read` de notas de voz sube; sin diferencias en Flows, pedidos y cron de InkaClick.

Si se despliega la imagen **antes** que la migración, los estados dejan de reflejarse (`PGRST202`, registrado) hasta aplicarla: no hay pérdida de mensajes, pero sí de estados.

## 6. Rollback

- **Imagen**: volver a la anterior. El código antiguo no usa las funciones y se comporta igual que antes con la migración presente (comprobado).
- **Funciones** (opcional, no hay datos que revertir):
  `DROP FUNCTION IF EXISTS public.apply_whatsapp_message_status(uuid, text, text, timestamptz); DROP FUNCTION IF EXISTS public.whatsapp_status_can_advance(text, text); DROP FUNCTION IF EXISTS public.whatsapp_status_rank(text);`
- Efecto del rollback: vuelven D1–D9.

## 7. Límites conocidos (fuera de este PR)

- Un evento aceptado con 200 y perdido antes de persistirse sigue sin reintento (H1 → PR-B).
- Un estado puede llegar **antes** de que la ruta de envío inserte la fila saliente: no hay fila que actualizar y el estado se pierde. Es anterior a este PR; lo cubriría el diario durable de PR-B.
- `failed` se trata como terminal, igual que ya hacían los destinatarios de broadcast; si Meta enviara un `delivered` posterior a un `failed` se ignoraría.
- Los 13 payloads indeterminados del incidente del 6/11 no se pueden reconstruir con este cambio.
