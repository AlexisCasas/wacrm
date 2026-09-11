# AUDITORÍA — Recuperación automática de Meta pair rate limit 131056

Estado: auditoría (rondas 1-2) + **FASE 1 IMPLEMENTADA** (motor de
Automations: propagación de outcome + ancestor continuation) + **FASE 2
IMPLEMENTADA** (`MetaApiError` + clasificador 131056) + **FASE 3
IMPLEMENTADA** (retry durable completo: migración 050, RPC atómico,
backoff/jitter/Retry-After, integración con el engine, retry_count
por-step, exact-step validation, log visual). Pendiente: pacing
preventivo (Fase 4), retry para Flows/AI/Broadcast (fuera de alcance).
Sin commit.

SHA base: `a5580fc559f3f7a6e7315855afafc9cf499cc6bb` (main, 2026-09-10).
Rama de trabajo: `fix/automation-branch-resume-continuation`.

## FASE 1 — implementada

`src/lib/automations/engine.ts` — los dos bugs confirmados en la
auditoría (propagación de pausa/fallo demasiado TEMPRANA, y ausencia
TOTAL de continuación de ancestros DESPUÉS de un resume) están
corregidos juntos, en el mismo cambio, exactamente porque estaban
acoplados (ver el veredicto de la ronda 2, sección A).

Resumen del diseño final (detalle completo en la entrega del chat):

- `ExecutionOutcome = { kind: 'completed' } | { kind: 'paused' } | { kind: 'failed'; message }`.
  `executeStepsFrom` ahora retorna esto en vez de `Promise<void>`.
- `finishScope(args, results, outcome, detail?)` — helper centralizado
  que persiste los `results` locales de UN scope exactamente una vez, en
  cada punto de salida (no solo al final del loop), y decide
  `automation_logs.status` SOLO cuando `parentStepId === null` (root
  real, sea en un dispatch síncrono o al final de un unwind). Los scopes
  anidados siempre pasan `status: null` — nunca declaran éxito/fallo
  global por sí mismos. `detail` (usado por `stopExecution`) preserva el
  comportamiento preexistente de grabar la razón de una parada auditable
  (`contact_blocked`, etc.) en `error_message` incluso cuando el outcome
  es `paused`, no solo `failed`.
- El handler de `condition` ahora hace
  `const childOutcome = await executeStepsFrom(...); if (childOutcome.kind !== 'completed') return finishScope(args, results, childOutcome); continue`
  — nunca más `continue` incondicional.
- `resumeAndUnwind()` (nuevo, usado SOLO por `resumePendingExecution`) —
  tras resumir una rama, si completa, reconstruye la cadena de ancestros
  consultando `automation_steps` (id/automation_id/step_type/position/
  parent_step_id/branch) — sin pila persistida — y continúa cada scope
  contenedor desde `position + 1` de su condición, repitiendo hasta la
  raíz real o hasta un outcome no-completado. Fail-closed si el ancestro
  no existe, pertenece a otra automation, o no es `step_type='condition'`.
- `resumePendingExecution()` usa `resumeAndUnwind`; marca la Pending
  resumida `'done'` siempre (su propio ciclo de vida, sin cambios), y
  además llama `finalizeLog(logId, 'failed', message)` explícitamente
  cuando el unwind falló ANTES de llegar a la raíz real (el único caso
  donde nadie más escribiría ese status).

**57/57 tests en `engine.test.ts`** (incluye CP-A a CP-I, más CP-H2, más
los 2 tests de propagación temprana ya convertidos de "BUG" a "FIXED").
114/114 en toda la carpeta `automations`+`api/automations`. Suite
completa: 1744/1746 (los 2 restantes son el baseline preexistente de
`date-utils`, sin relación). Typecheck limpio. Lint: 52/2/50, idéntico
al baseline conocido, cero problemas nuevos en los 2 archivos tocados.
`git diff --check` limpio.

## FASE 2 — implementada: `MetaApiError` + clasificador 131056

Alcance: solo `src/lib/whatsapp/meta-api.ts` (+ nuevo
`meta-error-classify.ts`) y sus tests. `engine.ts` **no se tocó** —
`classifyMetaSendError` no tiene todavía ningún llamador en Automations
ni en Flows; esa integración llega en la Fase 3, junto con migración
050 y el scheduler durable.

### Contrato final de `MetaApiError`

```ts
export class MetaApiError extends Error {
  readonly code?: number
  readonly errorSubcode?: number
  readonly type?: string
  readonly httpStatus: number          // SIEMPRE response.status, nunca inferido
  readonly retryAfterSeconds?: number
  readonly fbtraceId?: string
  readonly errorData?: unknown         // opaco, tal cual lo manda Meta
}
```
`extends Error`, `name = 'MetaApiError'`, `message` es EXACTAMENTE
`data.error.message` de Meta o el `fallback` del caller — nunca
reescrito. Nunca contiene el access token, el payload saliente, ni
headers completos — solo los 7 campos de arriba. Target `ES2017` en
`tsconfig.json` confirma que `extends Error` nativo preserva
`instanceof` correctamente sin necesitar `Object.setPrototypeOf`.

### `MetaErrorResponse` extendido

```ts
interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
    fbtrace_id?: string
    error_data?: unknown
  }
}
```
Todo opcional — ningún campo se asume presente. `throwMetaError` sigue
envolviendo la lectura completa (`response.json()` + extracción de
todos los campos) en el MISMO `try/catch` que ya existía, así que un
body vacío, JSON inválido, o JSON con forma inesperada (incluso `null`)
caen al mismo camino de fallback sin lanzar una excepción distinta.

### `parseRetryAfterSeconds` (Retry-After robusto)

Helper exportado y testeado directamente. Lee ÚNICAMENTE
`response.headers.get('retry-after')`. Acepta delta-seconds (`"120"` →
`120`) y HTTP-date (convierte a segundos contra un `now` inyectable —
usado en el test del caso HTTP-date con `vi.useFakeTimers()` +
`vi.setSystemTime()`, sin depender del reloj real). Falta / vacío /
no-numérico-no-fecha / fecha ya pasada / negativo → `undefined`. Nunca
impone backoff — solo preserva el dato.

### Clasificador

```ts
export type MetaSendErrorClassification =
  | { retryable: true; reason: 'meta_pair_rate_limit'; code: 131056; retryAfterSeconds?: number }
  | { retryable: false; reason: 'not_retryable'; code?: number }

export function classifyMetaSendError(error: unknown): MetaSendErrorClassification
```
Única fuente de verdad: `error instanceof MetaApiError && error.code === 131056`.
Nunca regex sobre `.message` — confirmado con un test dedicado
(`errorSubcode: 131056` con `code: 4` → `retryable: false`, y un
`Error('(#131056)...')` de texto plano → `retryable: false`). Todo lo
demás (429 sin ese code, 131030, 5xx, `TypeError` de fetch, `Error` de
"sent to Meta but DB insert failed" post-send, `null`/`undefined`,
string suelta) → `retryable: false`.

### `registerPhoneNumber` — fuera de alcance, confirmado intacto

No se tocó una sola línea. Sigue con su propio parseo inline
(`already registered`, PIN, mensajes UI-facing) y sigue lanzando
`Error` plano, nunca `MetaApiError`. Verificado por lectura — no
necesitó test nuevo, su comportamiento es idéntico byte a byte al de
antes de esta fase.

### 131030 — compatibilidad confirmada

`isRecipientNotAllowedError(message: string)` sigue recibiendo un
string via `err instanceof Error ? err.message : String(err)` en los 6
callsites existentes — sin cambios ahí. Test dedicado (CP-META-07)
confirma que un `MetaApiError` con `code: 131030` sigue produciendo
`isRecipientNotAllowedError(err.message) === true`.

### DB failure post-send — nunca envuelto en `MetaApiError`

`sendTextMessage`/`sendMediaMessage`/etc. de `flows/meta-send.ts` y
`automations/meta-send.ts` (no tocados en esta fase) lanzan
`new Error('sent to Meta but DB insert failed: ...')` — un `Error`
plano, nunca `MetaApiError`, porque ese fallo ocurre DESPUÉS de que
Meta ya aceptó el mensaje (ya existe un `wamid`). El clasificador lo
confirma: `classifyMetaSendError(new Error('sent to Meta but DB insert failed: ...'))`
→ `retryable: false` (test dedicado, caso 10 del classifier).

**52 tests nuevos** (`meta-api.test.ts` +30, `meta-error-classify.test.ts`
11) — todos verdes. Ver la entrega del chat para el detalle completo de
resultados.

## FASE 3 — implementada: retry durable completo

Alcance: `supabase/migrations/050_meta_rate_limit_retry.sql` (nueva),
`src/lib/automations/engine.ts` (integración), `meta-retry-backoff.ts`
(nuevo), `src/types/index.ts` (`retry_scheduled`), la UI de logs, y
`supabase/ci/verify-schema.sql`. Las dos correcciones de diseño que
quedaron pendientes al cierre de la Fase 2 (retry seed por-step, pacing
transport-aware) se implementaron/documentaron aquí — la primera
implementada, la segunda sigue diferida a Fase 4 según el propio pedido.

### Schema (050)

`automation_pending_executions` gana `retry_count INTEGER NOT NULL
DEFAULT 0`, `retry_reason TEXT` (nullable), `retry_step_id UUID`
(nullable, **sin FK** — el UUID debe sobrevivir a la edición/borrado del
step para que el resume pueda detectarlo). CHECK
`automation_pending_executions_retry_metadata_check`: o bien
`(retry_count=0, retry_reason IS NULL, retry_step_id IS NULL)` (wait
normal) o bien `(retry_count BETWEEN 1 AND 5, retry_reason IS NOT NULL,
retry_step_id IS NOT NULL)` (retry) — nunca una mezcla. El nombre del
reason NO está hardcodeado en el CHECK (solo el RPC restringe
`'meta_pair_rate_limit'` en esta versión).

### RPC — `schedule_automation_retry_if_contact_active`

RPC nuevo y separado (NO se tocó `schedule_automation_wait_if_contact_active`).
Antes de tocar `contacts`, valida en orden: `retry_count` 1..5,
`retry_reason = 'meta_pair_rate_limit'`, y que `retry_step_id`
corresponda EXACTAMENTE a un step con
`automation_id/position/parent_step_id (IS NOT DISTINCT FROM)/branch
(IS NOT DISTINCT FROM)` iguales a los argumentos, y `step_type` uno de
los 5 outbound — cualquier fallo aquí es `RAISE EXCEPTION ... USING
ERRCODE = '22023'` (error de programación, nunca confundido con "contact
blocked"). Luego el MISMO `SELECT ... FOR UPDATE` sobre `contacts` que
`block_contact_internal`/`schedule_automation_wait_if_contact_active` ya
usan — misma prueba de serialización, sin reabrir la carrera. `REVOKE
ALL ... FROM PUBLIC, anon, authenticated, service_role` explícito (la
lección de la ronda P3) + `GRANT ... TO service_role`.

Probado con Postgres real (Docker, throwaway, ya eliminado): replay
001→050 limpio, reaplicación idempotente de 050, y 6 escenarios
funcionales reales contra la RPC (retry_count fuera de rango, reason no
soportado, step_type no-outbound, mismatch de position, inserción
válida con metadata correcta, contacto bloqueado → `FALSE` sin insertar).

### Integración con el engine

`classifyMetaSendError` se invoca en el `catch` de `runStep`, SOLO
cuando `OUTBOUND_SEND_STEP_TYPES.has(step.step_type)` — nunca por el
tipo del error en sí. `scheduleMetaRateLimitRetry()` (nuevo helper)
agenda el retry con `next_step_position = step.position` (NUNCA +1 —
repite el mismo step) y retorna `{kind:'paused'}` vía `finishScope`,
exactamente como un `wait`. `resumePendingExecution` ahora: (1) lee
`retry_count/retry_reason/retry_step_id` de la MISMA query fresca
existente, nunca del objeto que pasa el cron; (2) falla cerrado si la
combinación es inconsistente; (3) para una fila con `retry_count>0`,
re-valida contra el estado ACTUAL de `automation_steps` (exact-step
validation) ANTES de intentar reanudar — si el step fue editado,
borrado, movido, o cambió de tipo, el resultado es `log failed`,
`Pending A done`, CERO ancestor continuation, detail interno
`retry_target_changed` (nunca expone nada sensible).

### `initialRetryCount` — por step, no por run (corrección de diseño de la Fase 2)

`ExecuteArgs.initialRetryCount` solo se siembra en la iteración
`stepIndex===0` del loop de `executeStepsFrom`; cualquier step posterior
en la MISMA llamada arranca en 0. `resumeAndUnwind` solo pasa el valor
real en su PRIMERA llamada (`retrySeed`), reseteando a 0 antes de subir
a cualquier scope ancestro. Probado explícitamente: step 10 reintenta 2
veces y tiene éxito; step 11 (siguiente, mismo scope) falla por primera
vez y agenda `retry_count=1`, nunca `3`.

### Backoff / jitter / Retry-After

`meta-retry-backoff.ts`: `MAX_META_RATE_LIMIT_RETRIES=5`, tabla fija
1→60s, 2→120s, 3→300s, 4→600s, 5→900s. `metaRateLimitDelayMs({retryNumber,
retryAfterSeconds, seed})` = `max(base, Retry-After) + jitter
determinista [0,5000]ms` — un `Retry-After` MENOR nunca acorta el
backoff propio; uno MAYOR sí lo extiende. Jitter derivado de un hash
simple del `seed` (nunca `Math.random()`) — misma entrada, mismo
resultado, siempre. No se duplicó `broadcast-retry.ts` (`batchRetryDelayMs`)
— ese helper es para reintento síncrono de un batch de broadcast (cap
120s, sin persistencia), un mecanismo genuinamente distinto de este
retry durable de varios minutos.

### Log / status

`AutomationLogStepResult.status` gana `'retry_scheduled'` — sin
migración (`steps_executed` es JSONB sin CHECK sobre su contenido). El
log general sigue usando `'partial'` mientras hay un retry pendiente
(reutiliza el mecanismo ya existente de `finishScope`, sin cambios ahí).
Al éxito del retry se añade una entrada NUEVA con el MISMO `step_id` y
`status:'success'` — `steps_executed` ya soporta múltiples entradas por
`step_id` (confirmado en rondas anteriores). UI
(`automations/[id]/logs/page.tsx`, `StepRow`): nueva rama visual ámbar
(ícono `Clock`) para `retry_scheduled`, distinta del verde (`success`) y
del rojo (`failed`/`skipped`) — antes ambos compartían el mismo ícono
rojo, haciendo que "esperando reintento" se viera idéntico a "falló
definitivamente".

### No-retry cases (confirmados con tests)

429 sin 131056, 131030, 500, `Error` de texto plano con "131056",
`TypeError` de fetch, fallo de persistencia post-send ("sent to Meta but
DB insert failed"), error estilo ManyChat, y un step NO-outbound
(`send_webhook`) que lanza un `MetaApiError(131056)` real — los 8 caen
al camino de fallo terminal existente, CERO llamadas al RPC de retry en
ninguno.

**Suite de `engine.test.ts`: 82/82.** Automations completo: 152/152.
Full suite: 1820/1822 (2 = baseline `date-utils`, sin relación).

**Pendiente para fases siguientes** (NO tocado en Fase 3): pacing
preventivo (`AUTOMATION_OUTBOUND_PACING_MS`, transport-aware — Fase 4
según el propio pedido), retry para Flows/AI/Broadcast (fuera de
alcance permanente), retry genérico de HTTP 429/timeout/5xx (fuera de
alcance permanente).

Historial de rondas de auditoría (previas a la Fase 1, ambas
test-only sobre `src/lib/automations/engine.test.ts`):

- Ronda 1: extiende el mock de `automation_steps` para filtrar de verdad
  por `parent_step_id`/`branch`/`position`, y agrega 2 tests de
  caracterización que prueban empíricamente el bug de propagación de
  pausa/fallo en ramas anidadas (pausa/fallo demasiado TEMPRANO).
- Ronda 2: agrega 5 tests de caracterización (A-E) que prueban
  empíricamente el bug de "ancestor continuation" — la mitad DESPUÉS del
  resume: hoy NADA continúa los scopes ancestros tras reanudar una rama,
  ni en éxito ni en fallo. Revela además un acoplamiento real entre los
  dos bugs: arreglar solo la propagación temprana sin agregar continuación
  de ancestros dejaría el step raíz sin ejecutarse NUNCA (regresión).
- **Fase 1**: implementa el fix real (`ExecutionOutcome` + `finishScope`
  + `resumeAndUnwind`) y convierte los 7 tests de caracterización en
  assertions de comportamiento correcto (CP-A a CP-I, más CP-H2, más
  los 2 tests de propagación temprana).
- **Fase 2**: `MetaApiError` + `classifyMetaSendError` — ver la sección
  "FASE 2" arriba. `engine.ts` no se tocó.
- **Fase 3 (esta entrega)**: retry durable completo — migración 050,
  RPC, backoff, integración con el engine, retry_count por-step,
  exact-step validation, log visual. Ver la sección "FASE 3" arriba.

## FASE 3.1 — implementada: recuperación de pending executions huérfanas

Alcance: `supabase/migrations/050_meta_rate_limit_retry.sql` (extendida,
NO se creó 051), `src/lib/automations/engine.ts` (claim token
plumbing), `src/app/api/automations/cron/route.ts` (claim/reclaim),
`supabase/ci/verify-schema.sql`. Cierra la ventana de crash/redeploy
que quedaba abierta al final de la Fase 3, ANTES de abordar pacing
(Fase 4). NO se tocó clasificación, backoff, MAX retries,
`retry_step_id`, exact-step validation, ni el mecanismo de ancestor
unwind — solo la plomería estrictamente necesaria para el claim token.

### El gap (confirmado empíricamente antes de tocar producción)

El claim original del cron era `UPDATE ... SET status='running' WHERE
id=? AND status='pending'`. Si el proceso moría DESPUÉS de ese claim
pero ANTES de que `resumePendingExecution` terminara (crash, redeploy,
OOM-kill), la fila quedaba en `status='running'` para siempre — el
cron solo hace `SELECT` de `status='pending'`, así que un `wait` (y,
más urgente, un retry Meta 131056, que el propio pedido exige que
"sobreviva redeploy/restart") podía dejar de procesarse silenciosamente,
sin error en ningún lado.

Confirmado con un test de caracterización ANTES de escribir el fix
(`src/app/api/automations/cron/route.test.ts`, CR-09): una fila
`status='running'` con `lease_expires_at` en el pasado, contra el cron
SIN PARCHEAR, arrojaba `processed: 0` — la fila nunca se recuperaba. El
test se dejó fallar deliberadamente en ese estado (sin "corregirlo
artificialmente") antes de tocar `cron/route.ts`, y solo después pasó a
verde una vez implementado el fix real.

### Diseño elegido: `claim_token` + `lease_expires_at`

Dos columnas nuevas en `automation_pending_executions` (migración 050,
sección 3 — extendida, no una migración 051 nueva, porque 050 seguía
sin commitear/desplegar):

- `claim_token UUID` — el token que identifica de forma inequívoca
  quién es el dueño ACTUAL de una ejecución `running`. Sin FK, sin
  relación con `retry_step_id` (ese identifica QUÉ se ejecuta; esto
  identifica QUIÉN la está ejecutando).
- `lease_expires_at TIMESTAMPTZ` — hasta cuándo ese dueño tiene el
  derecho exclusivo antes de que otro worker pueda reclamar la fila,
  asumiendo que el dueño original murió.

Se prefirió este par sobre `claimed_at` + `claim_token` (alternativa
evaluada) porque expresa ambas propiedades explícitamente: dueño
(`claim_token`) y vencimiento (`lease_expires_at`), en vez de requerir
que el lector derive "vencido" restando `claimed_at` de una constante
en cada sitio de chequeo.

CHECK `automation_pending_executions_claim_lease_check`:
`status='pending' → claim_token/lease_expires_at NULL`;
`status='running' → ambos NOT NULL`; `status IN ('done','failed')` sin
restricción (ver la sección de `block_contact_internal` abajo). Índice
parcial `idx_automation_pending_stale_running (lease_expires_at) WHERE
status='running'` — mismo patrón que `idx_automation_pending_due`
(migración 006) para la otra mitad del due-set del cron.

### Duración del lease — 15 minutos, justificada, no arbitraria

`AUTOMATION_PENDING_LEASE_MS = 15 * 60 * 1000` en `engine.ts`. Se
auditaron los fetch de `meta-api.ts` (`grep` de `signal`/`timeout`
sobre todo el archivo): **ningún** fetch a la API de Meta tiene
`AbortSignal` ni timeout — no existe hoy un límite superior real, a
nivel de aplicación, de cuánto puede tardar un step legítimamente vivo.
Ante esa ausencia, se optó por un lease conservador en vez de inferir
un bound que no existe: cualquier plataforma serverless realista
(Vercel incluido) mata la función mucho antes de 15 minutos de todos
modos, así que el lease casi nunca debería dispararse contra un worker
genuinamente vivo — solo contra uno que realmente murió. **Propuesta
para una fase futura, NO implementada aquí**: agregar
`AbortSignal.timeout(...)` a los fetch de `meta-api.ts` acotaría el
worst-case real y permitiría bajar la duración del lease con la misma
confianza; queda fuera de esta fase por alcance.

### Algoritmo de claim/reclaim — Opción A (extender el SELECT+UPDATE existente)

Se evaluaron dos diseños: (A) extender el `SELECT`+`UPDATE` condicional
que el cron ya usaba, con un filtro `.or(...)` que cubra AMBOS casos
("due" y "running con lease vencido"); (B) una RPC nueva tipo
`claim_due_automation_pending_executions`. Se eligió A: un `UPDATE ...
WHERE id=? AND (status='pending' OR (status='running' AND
lease_expires_at < now()))` es ya atómico por fila en Postgres — dos
workers concurrentes intentando la misma fila se serializan por el lock
de fila, y el segundo re-evalúa el `WHERE` contra el estado YA
actualizado por el primero, así que solo uno puede ganar. Una RPC nueva
no aportaba ninguna garantía adicional sobre esto, así que se descartó
por sobre-arquitectura.

`cron/route.ts`: el `SELECT` inicial y el `UPDATE` de claim comparten
la MISMA expresión `.or('status.eq.pending,and(status.eq.running,lease_expires_at.lt.<now>)')`.
Cada intento de claim genera un `claim_token` (`crypto.randomUUID()`) y
un `lease_expires_at` (`now() + AUTOMATION_PENDING_LEASE_MS`) NUEVOS —
un worker que reclama una fila vencida nunca reutiliza el token viejo.
El `claim_token` resultante se pasa a `resumePendingExecution`.

### Ownership en el engine — el mismo patrón que `pendingExecutionId`

`resumePendingExecution` ahora exige `claim_token` en su firma. Su
revalidación inicial (fresh SELECT) compara `freshPending.claim_token
!== pending.claim_token` exactamente igual que ya comparaba
`status`/`automation_id`/`account_id`/`contact_id` — si otro worker ya
reclamó la fila (nuevo token), este worker se detiene ahí mismo, sin
tocar `automation_steps` ni enviar nada.

`ExecuteArgs` gana `claimToken?: string`, propagado por
`resumeAndUnwind` exactamente como `pendingExecutionId` — el MISMO
`isPendingExecutionStillRunning()` ahora recibe y compara `claimToken`
además de `status`/`automation_id`/`account_id`/`contact_id`, y se
re-chequea antes de CADA step, en TODOS los scopes que visita el
ancestor unwind (no solo el primero). Un worker viejo cuyo lease
venció y fue reclamado por otro deja de matchear en el primer chequeo
posterior — nunca en un chequeo posterior al momento real del reclaim.

`markPending(id, status, expectedClaimToken)` — ahora **ownership-aware**:
`UPDATE ... SET status, claim_token=NULL, lease_expires_at=NULL WHERE
id=? AND status='running' AND claim_token=expectedClaimToken`. Si 0
filas matchean (la fila ya fue reclamada por otro, o ya no está
`running`), la llamada es un no-op — el worker viejo nunca puede pisar
el estado del nuevo dueño. Confirmado con Postgres real (ver sección de
validación): un `UPDATE` con el token viejo tras un reclaim afecta 0
filas; el mismo `UPDATE` con el token correcto sí aplica y limpia
`claim_token`/`lease_expires_at`.

### Interacción con `block_contact_internal` (migración 044)

El sweep bulk `pending/running -> done` de `block_contact_internal` NO
se tocó — sigue sin filtrar por `claim_token`. Efecto: si una fila
`running` de un Worker A es barrida a `done` por un bloqueo
concurrente, el `claim_token` de A queda físicamente en la fila (no se
limpia), pero es inerte — todo chequeo de ownership en `engine.ts`
empieza filtrando `status='running'` PRIMERO; en cuanto el status deja
de ser `running`, nada vuelve a mirar `claim_token`. Confirmado en
`engine.test.ts` (CP-I, actualizado en esta fase): tras el sweep, el
`markPending('done')` final de Worker A ahora es correctamente un no-op
(antes de este fix hubiera sido una escritura redundante pero
inofensiva) — el registro ya es terminal por la otra vía, no hay nada
que este worker deba (ni pueda) sobrescribir. No se amplió la función
de la migración 044 para limpiar estas columnas: hacerlo sería riesgo
innecesario sobre una función ya auditada, sin beneficio de
correctitud.

### Límite explícito: esto NO resuelve un send-in-flight cuando el lease vence

No existe una transacción distribuida entre el POST a Meta, el
`INSERT` en `messages`, y el estado de la fila pending — `claim_token`
NO puede garantizar exactly-once para un send que está literalmente en
vuelo en el momento exacto en que su lease expira y otro worker
reclama la fila. Lo que este diseño SÍ garantiza:

- Ninguna fila queda huérfana para siempre — un `running` con lease
  vencido siempre vuelve a ser candidata al siguiente tick del cron.
- Un worker viejo se detiene en el momento en que vuelve a tocar el
  motor (el próximo chequeo de ownership), nunca después.
- El lease conservador (15 min, sin timeout de Meta hoy) minimiza —
  pero no elimina — la ventana de duplicado.
- El retry queda at-least-once tras un crash, nunca "silenciosamente
  cero veces" (que era el gap original) ni garantizado exactly-once
  (que requeriría idempotencia del lado de Meta, fuera de alcance).

### El mismo sistema para wait normal y retry 131056

No se construyeron dos sistemas de claim separados. `retry_count=0`
(wait normal) y `retry_count>0` (retry Meta 131056) pasan por el
MISMO `resumePendingExecution`/`isPendingExecutionStillRunning`/
`markPending`, con el mismo `claim_token`. Efecto colateral deseado:
esto también cierra el gap de orfandad para un `wait` genérico, no solo
para retries — el gap nunca fue específico de Meta 131056, era
estructural del cron.

### Tests — CR-01 a CR-12

`cron/route.test.ts` (nivel claim/reclaim, donde ocurre el claim):
CR-01/02/03/04/09 — claim de un pending normal con token+lease;
overlap de dos invocaciones concurrentes (solo una gana); lease NO
vencido no se reclama; lease vencido SÍ se reclama con token NUEVO;
recuperación tras un "crash" simulado (CR-09, la prueba del gap antes
del fix, verde después).

`engine.test.ts`, nuevo describe "Meta 131056 — claim/lease ownership
(Phase 3.1)" (nivel ownership, donde se CONSUME el claim):
CR-05 (token viejo → `isPendingExecutionStillRunning` → cancelado, el
step nunca corre), CR-06 (el `markPending('done')` final del worker
viejo no puede modificar la fila del nuevo dueño), CR-07 (un resume
normal sí marca `done` y limpia `claim_token`/`lease_expires_at`),
CR-10/CR-11 (el mismo gate de ownership aplica idéntico para
`retry_count=0` y `retry_count>0` — nunca dos sistemas), CR-12 (Pending
A resuelto bajo su propio token crea Pending B sin metadata de claim
todavía — un pending recién insertado no tiene dueño hasta que un cron
lo reclama). CR-08 (bloqueo durante `running` detiene el siguiente
step) ya estaba cubierto por los tests P0 de contact-blocking
pre-existentes y por CP-I; no se duplicó.

**Suite de `engine.test.ts`: 88/88** (82 preexistentes + 6 nuevos de
esta fase). `cron/route.test.ts`: 6/6. `migration-050-meta-retry-rpc.test.ts`:
17/17 (14 preexistentes + 3 nuevos). Automations + `api/automations` +
whatsapp: 552/552. Full suite: 1831/1833 (2 = baseline `date-utils`,
sin relación). `npm run typecheck`: limpio. `eslint` sobre los archivos
tocados: limpio. `npm run build`: exitoso.

### Validación contra Postgres real (Docker, throwaway)

Replay completo 001→050 desde cero (`supabase db reset --local
--no-seed`): sin errores. Reaplicación de 050 sola: idempotente
(`NOTICE: column already exists, skipping` para cada columna, `CREATE
INDEX`/`CREATE FUNCTION` sin error). `verify-schema.sql`: pasa
completo, incluyendo la verificación explícita de
`anon`/`authenticated EXECUTE=false`, `service_role EXECUTE=true`, y
`PUBLIC` sin EXECUTE efectivo (vía `aclexplode`, ya que
`has_function_privilege` no acepta `'PUBLIC'` como rol) para
`schedule_automation_retry_if_contact_active`. No se creó ninguna RPC
nueva de claim/recovery en esta fase (Opción A, ver arriba), así que no
hay una segunda RPC que verificar ahí.

Smoke test funcional adicional (SQL throwaway, ya eliminado): insert
`pending` con `claim_token` no-NULL → rechazado por el CHECK; insert
`running` sin `claim_token`/`lease_expires_at` → rechazado; insert
`running` con ambos → aceptado; `UPDATE` ownership-aware con token
incorrecto → 0 filas afectadas, `status` sigue `running`; el mismo
`UPDATE` con el token correcto → aplica, `status='done'`,
`claim_token` queda `NULL`.

**Pendiente para fases siguientes** (NO tocado en Fase 3.1): pacing
preventivo (`AUTOMATION_OUTBOUND_PACING_MS`, transport-aware — Fase 4),
y la propuesta (no implementada) de `AbortSignal.timeout()` en los
fetch de `meta-api.ts` para acotar el worst-case real de un step en
curso y permitir revisar la duración del lease con ese dato.

## FASE 4 — implementada: pacing preventivo Meta transport-aware

Alcance: `src/lib/automations/engine.ts` (runtime de pacing +
integración en el loop de steps), `src/app/api/automations/cron/route.ts`
(sin cambios funcionales — el pacing vive enteramente dentro del
engine). NO se tocó Flows, AI, Broadcast, Inbox/manual sends,
clasificación 131056, backoff, lease/reclaim, ni migración 050. NO se
implementó pacing entre Automations distintas ni entre procesos —
alcance deliberadamente limitado a "esta misma ejecución/resume", ver
la sección de limitaciones más abajo.

### Objetivo y semántica

`AUTOMATION_META_OUTBOUND_PACING_MS = 1500` — un envío Meta-bound
espera, como máximo, lo que falte para completar 1500ms desde que el
ÚLTIMO envío Meta-bound de la MISMA ejecución terminó exitosamente.
Nunca duerme el intervalo completo si parte de él ya transcurrió
haciendo otro trabajo (`condition`, un step no-send, procesamiento
normal). El primer envío Meta de una ejecución nunca espera — no hay
nada previo contra qué pacearlo.

### Runtime efímero — `AutomationExecutionRuntime`

```ts
interface AutomationExecutionRuntime {
  lastMetaSendCompletedAtMs?: number
}
```

NO persistido — ni columna nueva, ni migración 051, ni Redis, ni un
`Map` module-level. Una única instancia (`runtime: {}`) se crea en cada
uno de los DOS puntos de entrada reales — `executeAutomation` (dispatch
síncrono) y `resumePendingExecution` (resume vía cron, sea `wait` o
retry 131056) — y la MISMA referencia fluye por:

- la recursión de `condition` dentro de `executeStepsFrom` (vía
  `{...args, ...}`, sin re-crear `runtime`);
- todo el ancestor climb de `resumeAndUnwind` (vía `{...base, ...}`,
  `runtime` agregado a su `Pick<ExecuteArgs, ...>`).

`ExecuteArgs.runtime` es un campo OBLIGATORIO (no opcional) — refuerza
en el tipo que todo call site real siempre tiene uno, nunca uno
implícito/omitido.

### `isAutomationMetaOutboundStep` — Meta-bound, no solo "puede llegar a Meta"

Deliberadamente DISTINTO de `OUTBOUND_SEND_STEP_TYPES` (que responde
"¿es uno de los 5 tipos que ALGUNA VEZ pueden llegar a Meta, sin
importar el transport?", relevante para clasificación 131056).
`isAutomationMetaOutboundStep(stepType, accountId)` responde "¿ESTE
send, PARA ESTA cuenta, va a llegar a Meta ahora mismo?":

- `send_buttons` / `send_list` / `send_template` → SIEMPRE Meta-bound
  (ManyChat no tiene primitiva de template ni de interactive-send hoy).
- `send_message` / `send_media` → Meta-bound SOLO si
  `resolveOutboundTransport(accountId) === 'meta'` — reutilizado
  VERBATIM desde `@/lib/whatsapp/send-message`, nunca se duplicó
  `WHATSAPP_OUTBOUND_TRANSPORT`/`MANYCHAT_INGEST_ACCOUNT_ID`.
- Cualquier otro step type → nunca Meta-bound.

Esto es lo que hace que una cuenta con `WHATSAPP_OUTBOUND_TRANSPORT=
manychat` siga paceando sus `send_template`/`send_buttons`/`send_list`
(Meta-only pase lo que pase) mientras sus `send_message`/`send_media`
NUNCA esperan ni tocan el timestamp Meta.

### Cuándo se actualiza el timestamp

`runtime.lastMetaSendCompletedAtMs = Date.now()` se escribe SOLO
inmediatamente después de que `runStep()` retorna SIN lanzar, y SOLO si
`isAutomationMetaOutboundStep` fue true para ese step. Nunca antes del
POST. Nunca si: el step agenda un retry 131056 (`scheduleMetaRateLimitRetry`
retorna antes de llegar a esa línea), cualquier otro error Meta
no-2xx, un error ManyChat, un error de validación, o un stop por
contacto bloqueado. Caso especial documentado en el propio código: Meta
acepta el envío pero la persistencia posterior en DB lanza — `runStep`
igual lanza en ese caso (nunca llega a marcar el timestamp), pero no
hace falta que lo haga: ese throw termina el scope completo, así que
NINGÚN send posterior en esa misma corrida existirá para pacear contra
él.

### Función de pacing — determinista, sin jitter

```ts
async function paceMetaOutbound(runtime): Promise<number> {
  if (runtime.lastMetaSendCompletedAtMs == null) return 0
  const elapsed = Date.now() - runtime.lastMetaSendCompletedAtMs
  const remaining = AUTOMATION_META_OUTBOUND_PACING_MS - elapsed
  if (remaining > 0) { await sleep(remaining); return remaining }
  return 0
}
```

Retorna los ms realmente dormidos (0 si no esperó nada) — el llamador
usa ese valor para decidir si vale la pena el recheck de ownership
post-sleep (ver más abajo). Sin `Math.random()`, sin jitter — el
jitter pertenece al backoff REACTIVO de 131056
(`meta-retry-backoff.ts`), que sí necesita romper un thundering herd de
reintentos agendados; este pacing es un único wait acotado inline en
una ejecución, sin ese problema.

### Propagación por conditions y por ancestor unwind

`condition`: la recursión de `executeStepsFrom` para la rama elegida
recibe `{...args, parentStepId: step.id, branch, startPosition: 0,
logId}` — `runtime` viaja sin cambios porque nunca se sobreescribe esa
clave. Confirmado con PC-06 (send Meta → condition YES → send Meta: el
segundo pacea contra el primero).

Ancestor unwind (`resumeAndUnwind`): `base.runtime` se pasa una única
vez al invocar la función, y CADA vuelta del `for(;;)` interno reutiliza
la MISMA `base` (por tanto el MISMO `runtime`) en su llamada a
`executeStepsFrom({...base, parentStepId, branch, startPosition,
initialRetryCount: retrySeed})`. Confirmado con PC-07: send Meta B
dentro de una rama anidada, climb hasta root, send Meta C en root —C
pacea contra B aunque estén en scopes distintos de la MISMA invocación
de resume.

### Reset en el boundary de Pending

`resumePendingExecution` crea SIEMPRE un `runtime: {}` fresco al armar
el `base` que pasa a `resumeAndUnwind` — nunca hereda nada del runtime
de la invocación anterior (la que originalmente pausó en ese `wait` o
agendó ese retry). Esto es intencional: el pacing existe para evitar
ráfagas DENTRO de una ejecución, no para forzar un intervalo mínimo
ENTRE dos invocaciones ya separadas por minutos (la duración de
cualquier `wait`/backoff real). Confirmado con PC-09 (primer send
después de un `wait` resume: 0 delay, no hereda nada de antes del
`wait`) y PC-08 (un retry resume: el propio send del retry no espera
nada adicional encima del backoff de 131056, pero el SIGUIENTE step
fresco en el mismo scope sí pacea contra él).

### Recheck de ownership post-sleep (sección 10 del pedido)

Ventana nueva que el pacing introduce: un pending válido pasa el gate
de ownership, se duerme paceando, y DURANTE ese sleep pierde ownership
(lease reclamada por otro worker, o `block_contact_internal` lo marca
`done`). Cierre: si `paceMetaOutbound` retornó un delay > 0 Y esta
ejecución tiene `pendingExecutionId`, se vuelve a llamar
`isPendingExecutionStillRunning` — el MISMO mecanismo de Fase 3.1,
nunca un sistema de ownership nuevo — inmediatamente antes de llamar a
`runStep`. Un delay de 0 no dispara el recheck porque no pasó tiempo
real en el que algo pudiera cambiar más allá de lo que el gate A ya
confirmó al principio de esa misma iteración. `PC-17` prueba el caso
"reclaim durante el sleep" (token nuevo → cancelado, el segundo send
nunca sale) y `PC-18` el caso "bloqueo durante el sleep" (reutilizando
que `block_contact_internal` marca el pending `done`, la misma memoria
de cancelación durable que ya usa `isPendingExecutionStillRunning`).

Los guards existentes (`assertContactCanReceive` dentro de cada uno de
los 5 senders) siguen intactos y sin tocar — el recheck de ownership es
ADICIONAL, no un reemplazo.

### Logs y UI — sin cambios

El pacing es transparente: no agrega entradas a `steps_executed`, no
agrega un status nuevo, no escribe nada en `automation_logs`. El
usuario solo ve los resultados reales de cada step, exactamente como
antes de esta fase. No hay setting de 1500ms expuesto — la constante es
interna.

### `runAutomationsForTrigger` — alcance "misma ejecución", no "global pair limiter"

Auditado: las automations encontradas para un trigger se ejecutan
secuencialmente en el mismo loop, pero cada `executeAutomation` crea su
PROPIO `runtime` — dos automations distintas disparadas para el mismo
contacto en el mismo trigger NO comparten pacing entre sí. Esto es
deliberado para esta v1 (ver limitaciones).

### Tests — PC-01 a PC-18

Todos con `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` /
`vi.setSystemTime` — ninguno duerme de verdad. Cada uno de PC-02/03/05/
06/07/08/12/13/14/15 demuestra la duración REAL esperada (avanza hasta
`interval-1`, confirma que NO se envió; avanza 1ms más, confirma que
SÍ) en vez de solo verificar que se llamó una función de sleep. PC-03
usa un hook nuevo y mínimo en el mock (`advanceClockOnContactUpdateMs`,
vía `vi.setSystemTime`, NUNCA un `vi.advanceTimersByTimeAsync` anidado)
para simular "procesamiento normal" entre dos sends a través de un
step `update_contact_field`. Un test PRE-EXISTENTE de Fase 3
("retry_count es per-step") pasó de 1515ms reales a 3ms al envolver su
único resume con el mismo patrón de fake timers — el pacing real que
ahora se dispara entre sus dos sends en el mismo scope se demuestra sin
dormir de verdad.

`engine.test.ts`: 106/106 (88 preexistentes + 18 nuevos de pacing).
Automations + `api/automations`: 195/195. Cron: 6/6. Backoff/migración
050/whatsapp: sin cambios de comportamiento, siguen en verde. Full
suite: 1849/1851 (2 = baseline `date-utils`, sin relación).
`npm run typecheck`, `eslint` sobre los archivos tocados, `git diff
--check`, y `npm run build`: todos limpios. Migración 050 NO cambió en
esta fase (confirmado por `git diff --stat`: el archivo permanece
untracked/sin tocar desde la Fase 3.1).

### Limitaciones documentadas (deliberadas para v1)

- **Cross-Automation / cross-process**: el runtime es puramente en
  memoria, por ejecución. Dos Automations independientes corriendo en
  paralelo para el mismo account/contacto, o dos instancias/procesos
  distintos, NO comparten este pacing — cada uno paceará sus propios
  envíos, pero un burst compuesto por AMBOS a la vez no se previene
  aquí. El retry reactivo 131056 (Fase 3) sigue siendo la red de
  seguridad durable para ese caso. NO se implementó mutex global, `Map`
  por account/contacto, advisory lock, tabla de throttle, ni Redis — si
  en producción persisten ráfagas cross-run, es un hardening posterior
  independiente, fuera de esta fase.
- **`amount <= 0` en `WaitStepConfig`**: auditado por pedido explícito
  de la Fase 4 (sección 15). Resultado: YA está cubierto, doblemente —
  `src/lib/automations/validate.ts` (`case 'wait'`) rechaza al guardar
  cualquier `amount` que no sea un número finito `> 0` ("wait amount
  must be greater than 0"), wireado en `POST/PATCH
  /api/automations(/[id])`; y `waitMs()` en `engine.ts` además clampea
  en runtime (`Math.max(1_000, cfg.amount * unitMs)`), un piso
  defensivo de 1 segundo aunque algún dato pre-existente en DB lo
  hubiera evadido. No hace falta ningún cambio: aunque existiera un
  `wait` de 0/negativo, el reset de runtime en el boundary de Pending
  (sección anterior) lo trataría exactamente igual que cualquier otro
  `wait` — no hay ninguna interacción especial con el pacing que
  dependa de la duración del `wait`.

## Revisión final pre-commit — estado y hallazgos

Revisión completa de TODO el diff acumulado (Fases 1–4) archivo por
archivo, con validación empírica contra Postgres real, antes del
primer commit de esta rama. Ver el reporte completo entregado en esa
sesión para el detalle exhaustivo (ExecutionOutcome, ancestor unwind,
Meta error boundary, exactly-once, retry count/identity, claim
race/token, block-contact, pacing+ownership, privilegios RPC, logs) —
todo confirmado correcto por lectura directa del código final y, donde
aplicaba, contra Postgres real. Dos hallazgos concretos:

1. **BLOCKER — CORREGIDO en esta revisión**:
   `automation_pending_executions_claim_lease_check` (migración 050,
   sección 3) se valida contra TODAS las filas existentes al momento
   del `ALTER TABLE ... ADD CONSTRAINT`. Una fila histórica
   `status='running'` creada por el cron PRE-050 (que no conocía
   `claim_token`/`lease_expires_at`) tiene ambas columnas en `NULL`
   tras el `ADD COLUMN` — eso no satisface ninguna de las 3 ramas del
   CHECK, así que **la migración completa fallaba** en cuanto existía
   una sola fila así.

   **Reproducción real (antes del fix)**: replay 001→049, INSERT de
   una fila `pending` válida per schema 049, `UPDATE ... SET
   status='running' WHERE status='pending'` (exactamente lo que hacía
   el cron pre-050), luego apply de 050 sin el backfill →
   `ERROR: check constraint "automation_pending_executions_claim_lease_check"
   ... is violated by some row` — migración detenida a mitad de
   camino (columnas y el primer CHECK ya commiteados; el segundo
   CHECK, el índice y el RPC nunca llegaban a crearse). Adicionalmente,
   incluso si el CHECK se hubiera relajado sin backfill, esa misma fila
   (`lease_expires_at IS NULL`) nunca habría sido seleccionada por el
   filtro del cron (`lease_expires_at < now()` es `NULL`, no `TRUE`,
   cuando el operando es `NULL` — confirmado con SQL directo) —
   habría quedado huérfana para siempre.

   **Fix aplicado**: un `UPDATE` de backfill, en `050_meta_rate_limit_retry.sql`,
   insertado ANTES del `ADD CONSTRAINT
   automation_pending_executions_claim_lease_check` (justo después del
   `ADD COLUMN` de `claim_token`/`lease_expires_at`):

   ```sql
   UPDATE public.automation_pending_executions
   SET
     claim_token = COALESCE(claim_token, uuid_generate_v4()),
     lease_expires_at = COALESCE(
       lease_expires_at,
       now() - interval '1 minute'
     )
   WHERE status = 'running'
     AND (
       claim_token IS NULL
       OR lease_expires_at IS NULL
     );
   ```

   `uuid_generate_v4()` (no `gen_random_uuid()`) por ser la función UUID
   que este schema usa desde la migración 001. El `COALESCE` en ambas
   columnas + el guard `claim_token IS NULL OR lease_expires_at IS
   NULL` hacen que el UPDATE sea un no-op para cualquier fila que un
   claim REAL ya haya tocado (su propio token, su propio lease futuro)
   — nunca pisa una ownership real. El lease sintético se genera
   DELIBERADAMENTE ya vencido (`now() - interval '1 minute'`, nunca uno
   futuro): estas filas legacy no representan un claim vigente de
   ningún worker vivo, así que deben quedar inmediatamente reclamables
   por el próximo tick del cron — exactamente por la MISMA vía de
   "lease vencido" que cualquier fila que hubiera muerto a mitad de un
   `wait`/retry normal, sin ningún camino especial para "fila legacy"
   en ningún otro lugar del sistema.

   **Reproducción real (después del fix)**: mismo escenario (replay
   001→049, fila legacy `running`) → apply de 050 completa sin error
   → fila resultante: `status='running'`, `claim_token IS NOT NULL`,
   `lease_expires_at IS NOT NULL`, `lease_expires_at < now()`. Reclaim
   con la lógica EXACTA del cron (`UPDATE ... WHERE id=? AND
   (status='pending' OR (status='running' AND lease_expires_at<now()))`)
   → afecta 1 fila, token sintético reemplazado por uno nuevo, lease
   nueva en el futuro; el mismo reclaim inmediatamente después →
   afecta 0 filas. Reapply de 050 sobre la fila YA reclamada
   (token/lease reales, no sintéticos) → el backfill no la toca
   (`UPDATE 0`) — valores idénticos antes/después, confirmado
   comparando explícitamente. `verify-schema.sql` → `schema
   verification passed`. Replay limpio 001→050 desde cero (sin filas
   legacy) → sin cambios de comportamiento, backfill es no-op.

   **Riesgo residual documentado, no eliminable por SQL**: un worker
   PRE-050 genuinamente vivo (todavía ejecutando código viejo, sin
   noción de `claim_token`) en el instante exacto en que esta migración
   corre puede seguir escribiendo esa fila sin ningún chequeo de
   ownership — es una ventana inherente a cualquier cambio de esquema
   en caliente durante un rollout con código viejo y nuevo coexistiendo
   brevemente, no algo que una migración pueda cerrar por sí sola.
   Mitigación operativa recomendada para producción: hacer un
   **preflight** antes de aplicar 050 — confirmar cuántas filas
   `status='running'` existen y, si el volumen lo justifica, aplicar la
   migración en una ventana donde el cron viejo no esté a mitad de
   procesar un batch (p. ej. inmediatamente después de un tick, antes
   del siguiente). El backfill en sí es seguro de aplicar siempre — el
   riesgo es exclusivamente sobre un worker viejo procesando esa MISMA
   fila en el instante exacto de la migración, no sobre la migración en
   sí misma.

2. **Corregido durante esta revisión**: `cron/route.ts` no envolvía
   `await resumePendingExecution(...)` en try/catch — una excepción no
   capturada en cualquier punto de esa función (fuera del try/catch
   interno que ya cubre `resumeAndUnwind`/`markPending`/`finalizeLog`)
   abortaba el `GET` completo, dejando sin procesar el resto del batch
   de esa invocación. `runAutomationsForTrigger` ya tenía exactamente
   esta protección por automation (`try { await executeAutomation(...) }
   catch`); `cron/route.ts` ahora replica el mismo patrón por fila,
   logueando server-side y continuando con la siguiente. La fila que
   falló no queda huérfana — ya tiene un lease real desde el claim
   previo, así que se recupera sola cuando ese lease vence. Test nuevo:
   `cron/route.test.ts` — "a defective row never blocks the rest of the
   batch".
