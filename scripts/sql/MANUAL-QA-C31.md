# QA manual técnico — E4.2C3.1 (Meta simulado + Inbox)

Todo corre en un **PostgreSQL 17 aislado** (contenedor sin red y sin puertos publicados) con las migraciones 001–060 y un
**transporte HTTP simulado**. No hay llamadas a Meta, ni credenciales reales, ni producción. No hay interfaz nueva: se usa
un script y `psql`.

## 0. Preparación (≈1 min)
```bash
cd /opt/apps/wacrm-e4-engine
./scripts/sql/manual-qa-c31.sh up          # debe terminar con: network: none, published ports: 0
```
Cada escenario es un comando `run <nombre>` que imprime `SCENARIO <nombre>: PASS` o `FAIL`. Después, `inspect` muestra los datos
reales que dejó en la base:
```bash
./scripts/sql/manual-qa-c31.sh inspect     # runs, ledger de efectos, mensajes del Inbox, conversaciones y trazas
./scripts/sql/manual-qa-c31.sh psql        # shell SQL si quieres consultar a mano
```

## 1–4, 8. Texto y multimedia desde un subflow, `messages`, `conversations`, retorno al flow principal
```bash
./scripts/sql/manual-qa-c31.sh run send && ./scripts/sql/manual-qa-c31.sh inspect
```
Flujo simulado: **A** (`start → call → fin`) llama a **B** (`bstart → bmsg|pic → bend`), y al volver ejecuta `fin`.

| Qué mirar en `inspect` | Valor esperado |
|---|---|
| runs | los dos últimos runs: `completed`, `node = fin`, `depth = 0`, `messages = 1`, `end_reason = end_node` (retorno a A y cierre) |
| effects | `bmsg` / `send_message` y `pic` / `send_media`: `confirmed`, `attempt = 1`, con `wamid` sintético `wamid.HBg…` |
| Inbox messages | texto: `bot`, `text`, `Hola Ana`, `status = sent`; media: `bot`, `image`, `Para Ana`, `media_url = https://example.test/pic.png`, `status = sent` |
| conversations | `preview` = último texto (`Hola Ana` / el caption `Para Ana`) y `at` reciente |
| trace | por run: `subflow_called` → `effect_registered` → `effect_claimed` → `effect_confirmed` → `subflow_returned` |

**PASS** si el comando imprime `SCENARIO send: PASS` y la tabla coincide. **FAIL** si hay un mensaje `delivered`/`read` (el motor solo
escribe `sent`), dos mensajes para el mismo `wamid`, o un run sin `fin`.
Comprobación extra de duplicados (debe devolver **0 filas** las dos):
```sql
select message_id, conversation_id, count(*) from messages group by 1,2 having count(*) > 1;
select provider_message_id, count(*) from flow_run_effects where provider_message_id is not null group by 1 having count(*) > 1;
```

## 5. Rechazo de `wamid` duplicado
```bash
./scripts/sql/manual-qa-c31.sh run duplicate
```
Un segundo run recibe del proveedor simulado un `wamid` que ya pertenece a otro efecto.
```sql
-- el conflicto quedó registrado como ambiguo, con el código wamid_conflict
select left(flow_run_id::text,8) run, payload->>'error_code' code from flow_run_events
 where event_type = 'effect_ambiguous' and payload->>'error_code' = 'wamid_conflict';
```
El test comprueba, **en el momento del conflicto**, que el segundo run seguía en el nodo del mensaje (`bmsg`), con 0 mensajes de
presupuesto y revisión sin cambios; al final del test lo resuelve con otro id y lo completa, así que ese estado intermedio **no** queda
visible en `inspect` (sí lo deja la traza de arriba).
**PASS**: `SCENARIO duplicate: PASS`; el mensaje y el vínculo del primer run no cambian (el test los compara byte a byte) y las
consultas de duplicados siguen en 0 filas; el segundo run solo obtiene su mensaje cuando se resuelve con un id **distinto**. Nota: si el test luego lo resuelve con otro id, el
efecto queda `confirmed` conservando `error_code = wamid_conflict` como historial.

## 6. Bloqueo por resultado ambiguo
```bash
./scripts/sql/manual-qa-c31.sh run ambiguous && ./scripts/sql/manual-qa-c31.sh inspect
```
Tres casos: timeout tras aceptación, respuesta perdida y desconexión en vuelo.
**Observa**: runs en `active`, `node = bmsg`, `depth = 1`, `messages = 0`; efectos `ambiguous`, `attempt = 1`, con `error_code` tipo
`transport_timeout@v0` / `transport_unknown@v0` / `transport_reset@v0`; **ningún mensaje en el Inbox** para esos runs.
**PASS**: `SCENARIO ambiguous: PASS` y el test comprueba además que 3 invocaciones repetidas hacen **1 sola** petición HTTP.
**FAIL**: un efecto ambiguo con `attempt > 1`, o un mensaje en el Inbox sin evidencia.

## 7. Recuperación sin reenvío
```bash
./scripts/sql/manual-qa-c31.sh run recovery && ./scripts/sql/manual-qa-c31.sh inspect
```
Simula la muerte del proceso (a) tras la aceptación del proveedor y antes de guardar el resultado, y (b) tras guardarlo y antes de avanzar.
**Observa** en `trace`: caso (a) `effect_claimed → effect_ambiguous → effect_resolved` (con evidencia sintética) y luego `subflow_returned`;
caso (b) sin `effect_ambiguous`. En ambos, un solo mensaje en el Inbox y `attempt = 1`.
**PASS**: `SCENARIO recovery: PASS` (el test verifica **1 petición HTTP y 1 fila de Inbox** por caso). **FAIL**: dos filas o `attempt = 2`.

## Todo de una vez y limpieza
```bash
./scripts/sql/manual-qa-c31.sh run all     # los 9 tests de integración del adaptador (N01–N19)
./scripts/sql/manual-qa-c31.sh down        # borra el contenedor y sus datos
docker ps -a --filter name=wacrm-manual-qa # debe estar vacío
```
La regresión completa (≈10 min, contenedor propio): `./scripts/sql/run-e42c31-qa.sh` → `E4.2C3.1 META ADAPTER OFFLINE PASS`.
