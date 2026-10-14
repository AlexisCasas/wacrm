# P8: ejecución de subflujos con retorno (A → B → A → C → A)

Estado: **desarrollado y probado en bases desechables, NO desplegado y la migración 070 NO está aplicada en producción.** La ejecución real
de esperas, F06 y el cron por minuto siguen apagados. Rama de desarrollo `feat/subflow-execution` (worktree `<repo>`), creada desde P7.

## 1. Qué hace
`INICIO A → Ejecutar B → regresa a A → Ejecutar C → regresa a A → FIN`, en **una sola ejecución** por contacto (el índice
`idx_one_active_run_per_contact` no se toca). B y C pueden tener esperas (13 minutos), condiciones, botones y listas.

* **Pila persistente (migración 070).** `flow_runs.current_flow_id` (NULL = el flujo raíz `flow_id`) dice en qué flujo está la ejecución; cada llamada
  activa es una fila de `flow_run_subflow_frames` (llamador, nodo de llamada, nodo de retorno, llamado, hashes de ambos grafos, referencia heredada,
  política ante respuesta, hora de la llamada). Dos llamadas **secuenciales** son profundidad 1 cada una; solo la anidación cuenta (máximo 3).
* **Entrar y volver son RPC atómicas** (`push_flow_subflow`, `pop_flow_subflow`), con bloqueo de fila sobre la ejecución: dos workers no pueden ganar la
  misma llamada ni el mismo retorno. La base revalida todo (cuenta, nodo de llamada real, destino activo de la misma cuenta, ciclos, profundidad, presupuesto
  de 8 llamadas por ejecución, habilitación), sin fiarse de lo que diga el motor.
* **Fin con dos alcances.** `scope` ausente o `"run"` = **comportamiento histórico: termina toda la ejecución**, esté donde esté. `scope: "subflow"`
  = termina este flujo y regresa al llamador (fuera de un subflujo se comporta como el histórico). **Consecuencia práctica:** para que A siga a C, el Fin de B y de C
  debe ser «terminar este flujo y regresar»; un Fin por defecto en B corta todo (nunca ejecuta C). Al activar A, el panel avisa si el flujo llamado nunca devuelve el control.
* **Referencia entre flujos.** El nodo de llamada tiene `reference_node_key` (un envío de A, validado dentro de A). Al entrar, el primer envío de ese nodo viaja
  como `$inherited` del llamado; al volver, la base restaura la del marco padre (o ninguna). La condición de B elige «Mensaje de referencia heredado del flujo
  llamador» (`subject_key = "$inherited"`). El editor **no puede apuntar a nodos de otros flujos ni cuentas**; la consulta de P7 revalida cuenta, contacto y conversación.
  Las referencias se guardan ahora con clave `flow_id#node_key` (dos flujos pueden tener un nodo `info`); no hay ejecuciones con referencias en producción, así que no hay datos que migrar.

## 2. Garantías de seguridad (fallan cerradas)
| Riesgo | Control |
|---|---|
| A o B cambian mientras la ejecución está suspendida | Cada marco fija el hash de ambos grafos (nodos, tipos, configuración y entrada; no la posición en el lienzo). Se verifica **antes de reanudar** una espera, antes de contestar un botón, antes de entrar a otro nivel y **en el retorno**. Si algo cambió, dejó de estar activo o es de otra cuenta, la ejecución termina `failed` y no se envía nada más |
| Ciclos / profundidad | La base rechaza un flujo ya presente en la pila (incluida la raíz) y un 4.º nivel; activar A también lo rechaza antes (grafo de llamadas de la cuenta) |
| Bucle de llamadas secuenciales | Presupuesto de 8 llamadas por ejecución |
| Cruce entre empresas | El destino debe ser de la cuenta de la ejecución y estar activo (RPC); el nodo de llamada se lee de la base; 068 ya impedía crear el nodo hacia otra cuenta |
| Habilitación | Dos llaves obligatorias: `FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS` (servidor) **y** una fila en `flow_execution_enablement` (tabla vacía; `anon`/`authenticated` ni la leen; `service_role` solo `SELECT`, nunca escribe: solo un operador privilegiado). Los triggers de activación de 068/069 consultan esa tabla; sin fila se comportan exactamente como antes |
| Respuesta espontánea del cliente | Ver §3 |
| Mensajes entrantes en el mismo segundo | Ver §3 |
| Envío con resultado desconocido | Ver §4 |

## 3. Respuestas del cliente
* Una respuesta **espontánea** es la que llega mientras la ejecución está **aparcada en una espera**: queda registrada de forma estricta (`reply_received` con
  `during_wait`); si no se puede registrar, la ejecución termina `failed` (`reply_not_recorded`) y el mensaje sigue en Inbox/automatizaciones (`consumed:false`).
  Las respuestas a un botón, lista o `collect_input` las consume ese nodo y **no** se registran así, por lo que **nunca** detienen el flujo.
* `on_customer_reply` de la llamada: `stop` (por defecto) o `continue`. Con `stop`, **antes de cada envío** dentro del subflujo y antes de volver al llamador se
  comprueba si hubo una respuesta espontánea desde la llamada; si la hubo, no se envía nada más y la ejecución termina `completed / customer_replied_in_subflow`.
* La condición P7 sigue siendo la herramienta explícita («¿respondió después del mensaje de referencia?») y su guarda previa al envío se conserva.
* **Marcas de tiempo de Meta (segundos enteros).** La referencia guarda el segundo de la base de datos redondeado hacia abajo y los ids de mensajes del cliente
  **ya almacenados** cuyo sello cae en ese segundo hasta nuestra hora. Respuesta = mensaje del cliente con sello ≥ ese segundo que no esté en esa lista: un mensaje ya
  guardado (p. ej. el que disparó el flujo) nunca cuenta; una respuesta que Meta sella antes que nuestra hora, pero llega después, sí cuenta. Si dentro de ese segundo hay más de 20 mensajes
  la referencia **no se registra** y el seguimiento no se envía (no se puede determinar con fiabilidad).
* **Automations.** El motor de Automations nunca toca `flow_runs` (lo prueba su propia suite) y no puede iniciar flujos ni devolver el control a A: el único camino de
  retorno es `pop_flow_subflow` desde el motor. El inicio manual de un agente choca con el índice (`duplicate_active_run`). Cuando un agente responde, `send-message.ts` pausa la ejecución
  completa (pila incluida). La IA y las automatizaciones pueden contestar un mensaje espontáneo (siguen viéndolo); con `stop` el flujo no añade un segundo mensaje comercial.

## 4. Recuperación e intención de envío (sin afirmar «exactamente una vez»)
* Antes de cada envío (mensaje, archivo, pregunta, botones, lista) el motor escribe el evento `send_intent`; si no puede escribirlo, **no envía** (`send_intent_not_recorded`).
  Solo las cuentas con ejecución habilitada pagan este registro: el resto conserva el camino histórico sin cambios.
* `recoverStrandedRuns` (ruta `/api/flows/recovery/cron`, **preparada y no instalada**, no hace nada con la lista de cuentas vacía) examina ejecuciones activas, sin espera, en un nodo
  que avanza solo (nunca las que esperan un botón) y con el cursor antiguo. Con los eventos posteriores al cursor:
  * **sin intención ni envío** → se reanuda (toma la ejecución con compare-and-set sobre el cursor: dos workers no la reanudan dos veces);
  * **intención sin confirmación** → resultado desconocido: **no se reenvía**, termina `failed / send_outcome_unknown` y queda el incidente;
  * **envío ya confirmado tras el cursor** → no se puede reproducir con seguridad: `failed / recovery_not_safe`.
* **Garantía real.** El diseño evita reenviar automáticamente cualquier resultado ambiguo y no se observó ningún duplicado en las pruebas con carreras (S14, S16), pero **no se demuestra una
  garantía total ni de «exactamente una vez»**: el Cloud API de WhatsApp no ofrece clave de idempotencia. Quedan ventanas: la propia llamada a Meta (decenas de ms; una respuesta en ese instante no
  se puede frenar), y un fallo entre la aceptación de Meta y el registro `message_sent` (se detecta como ambiguo y se registra, pero el mensaje pudo haber salido).

## 5. Pruebas (bases PostgreSQL/PostgREST desechables, envíos simulados, sin red)
* `npm test`: **2100 pasan**, 53 omitidas (las de PostgreSQL/PostgREST); `tsc` limpio; lint 0 errores y 48 avisos (línea base).
* SQL (`qa/subflow-exec/run-db-qa.sh --e4-migrations …`): **T01-T14 PASS en los tres órdenes** (solo `main`; E4 052-066 antes; 070 antes que E4), con carreras reales de 2 sesiones
  (llamada, retorno y llamada contra edición del llamado). Las suites de 067, 068 y 069 también pasan con la 070 aplicada.
* Motor (`qa/subflow-exec/run-engine-qa.sh [--e4-migrations …]`): **S01-S22 PASS (25 pruebas) en ambos órdenes**; P6 (E01-E12) y P7 (R01-R14) siguen pasando.
  S01 A→B→A→C→A con espera de 13 min; S02/S05 B termina toda la ejecución y C nunca corre; S03 respuesta antes de programar la espera; S04 texto/botón/lista/imagen/audio; S06 retorno normal;
  S07 A modificado con B suspendido (y durante los últimos pasos de B); S08 B modificado o desactivado; S09 respuesta legítima a un botón dentro de B; S10 respuesta espontánea con `stop`/`continue`;
  S11 marcas de tiempo del mismo segundo; S12 resultado indeterminable → no se envía; S13 reinicio; S14 dos workers; S15-S16 recuperación y carrera de recuperadores; S17 agente/bloqueo/flujo apagado;
  S18 cuentas, llaves y cruce entre empresas; S19 profundidad y ciclos; S20 sin impacto en flujos existentes; S21 intención antes del envío; S22 respuesta no registrable.
* **Pruebas de mutación** sobre el motor (cada mutante hace fallar la suite): sin verificación de pila al reanudar (S07, S08); respuesta espontánea nunca detectada (S10); intención de envío no escrita (S21);
  mensajes ya guardados no excluidos (S11); Fin que ignora su alcance (11 pruebas).
* Ensayo de la 070 sobre una **restauración del respaldo de producción** (336 flujos, 1773 nodos, 19 904 ejecuciones): 153 ms, hash de flujos/nodos/ejecuciones idéntico antes y después, tabla de habilitación vacía, `anon` sin acceso.

## 6. Impacto de la migración 070 sobre tablas compartidas
| Objeto | Cambio | Riesgo |
|---|---|---|
| `flow_runs` | **1 columna nullable** `current_flow_id` (+ CHECK) | Metadato; sin reescritura de tabla; todas las filas quedan NULL; los índices existentes no cambian |
| `flows`, `flow_nodes` | Solo se reemplazan **dos funciones** de trigger (068/069); los triggers y sus cláusulas `WHEN` no cambian | Sin fila de habilitación, mismo comportamiento y mismos códigos de error |
| `flow_run_events` | Ninguno (los eventos nuevos reutilizan tipos existentes) | — |
| Tablas nuevas | `flow_execution_enablement` (vacía) y `flow_run_subflow_frames` | Sin permisos para usuarios finales |
| Compatibilidad E4/F06 | Ningún nombre, restricción ni tipo de evento de 052-066 se reutiliza | Probado en tres órdenes |
Cambios de código visibles para **todas** las cuentas: ninguno en su camino de ejecución (sin `execute_flow`, sin condición, sin espera: mismos mensajes, mismos motivos de fin, `vars` y `current_flow_id` intactos; S20). El editor solo ofrece las opciones nuevas (referencia, política, alcance del Fin) donde `subflowAuthoring` esté habilitado.

## 7. Plan de despliegue
**Fase A, autoría (requiere tu autorización; sin ejecución):**
1. Preflight y línea base (flujos, nodos, ejecuciones, WhatsApp, errores, flags sin valores); la imagen actual es P7.
2. Respaldo `pg_dump -Fc` + sha256 + restauración de prueba; copia de `.env.local` y compose.
3. Ensayo de la 070 sobre la restauración (hecho: 153 ms, datos idénticos; se repite con el respaldo nuevo).
4. `psql -1 -v ON_ERROR_STOP=1 < 070` **antes** de la imagen (la ruta de compatibilidad de downgrade lee la columna nueva); verificar tablas vacías, permisos y funciones solo `service_role`.
5. Imagen inmutable desde `git archive` del commit; override `docker-compose.p8.yml`; `up -d --no-deps app`; sin variables nuevas.
6. Verificar salud, 401 sin sesión, datos idénticos, 0 ejecuciones nuevas, logs; QA manual de autoría con Pilot (llamar a B y C, referencia, política, alcance del Fin; activar sigue rechazado).
7. Rollback: override P7; la 070 puede quedarse (aditiva). Antes: `downgrade-compatibility` (`nested_run_ids`, flujos con `execute_flow`).

**Fase B, ejecución (orden aparte, con una cuenta de prueba y un contacto autorizado; NO antes):**
`FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS` + `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` + `FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS` (el de P7 ya existe) + fila en `flow_execution_enablement` (operador) +
instalar **dos** entradas de cron por minuto (`/api/flows/waits/cron` y `/api/flows/recovery/cron`): **cambia el scheduler compartido; me detengo a presentar el impacto antes**.

## 8. Riesgos que aún bloquean los envíos reales
1. Falta una ejecución real autorizada con un contacto de prueba (y la decisión del propietario sobre las ventanas del §4).
2. Instalar el cron por minuto cambia el scheduler compartido.
3. Confirmar la configuración de IA de Pilot (una respuesta de IA/automatización a un mensaje espontáneo no la controla este diseño).
4. Reloj: la condición asume relojes sincronizados con los sellos de Meta (NTP activo en la VPS).
5. Editar un flujo activo con ejecuciones en curso (por diseño las termina cerradas); conviene pausar flujos solo cuando no haya esperas pendientes.
6. Un Fin por defecto en un flujo llamado corta toda la ejecución: documentado y avisado al activar, pero depende de configurar bien B y C.
7. Secretos expuestos en la sesión de P4 sin rotar (pendiente heredado).
