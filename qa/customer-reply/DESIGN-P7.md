# P7: condición «Cliente respondió después del mensaje de referencia»

Estado: **desarrollado y probado, NO desplegado.** No hay migraciones. La ejecución real de esperas (`FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS`),
el cron por minuto y F04/F06 siguen apagados.

## 1. Diseño técnico

**Qué es.** Un nodo `condition` existente con `subject: "customer_activity"`, `operator: "replied_after_reference"` y `subject_key` = la
`node_key` del paso «Enviar mensaje» / «Enviar archivo» cuyo **primer envío exitoso** es la referencia. Ramas: `true_next` = SÍ respondió,
`false_next` = NO respondió. No hay motor nuevo ni nodo nuevo (la restricción `flow_nodes_node_type_check` no cambia; compatible con la 058 de E4).

**Referencia explícita y persistente.** Al enviar un nodo al que apunta alguna condición, el motor lee la fila `messages` que el propio envío
acaba de guardar (clave `conversation_id + message_id` = wamid, índice único existente) y guarda en `flow_runs.vars["$refs"][node_key]` =
`{message_id, conversation_id, sent_at}` (`sent_at` = `created_at` de esa fila, reloj de la base de datos). Solo se registra el **primer** envío de
ese nodo (un bucle no la mueve). Si hay varios mensajes iniciales, la referencia es el nodo elegido en la condición («el comienzo del bloque
informativo»). `vars` ya existe y se persiste: la referencia sobrevive a reinicios y a la espera de 13 minutos. La clave `$refs` no puede chocar con
variables del usuario (`var_key` solo admite letras, dígitos y `_`, y `{{vars.x}}` tampoco).

**Evaluación (una pregunta, sin texto).** Tres consultas indexadas, una sola vez por condición:
1. `conversations` de ese contacto y cuenta (`idx_conversations_account_contact`, único).
2. La fila de referencia por clave primaria, verificando que pertenece a esas conversaciones y que no es del cliente.
3. ¿Existe `messages` con `sender_type='customer'`, de esas conversaciones, con `created_at >` referencia? (`idx_messages_conversation`, `LIMIT 1`).

Cuenta como respuesta **cualquier** mensaje `customer`, sea cual sea su `content_type`: texto, imagen, audio, video, documento, ubicación, sticker y
toques de botón/lista (`interactive`). No cuentan `agent`, `bot` (incluye IA y automatizaciones) ni reacciones (no se guardan como mensajes).
No hay listas de frases ni comparación de texto. Costo medido en producción (solo lectura, `EXPLAIN ANALYZE`) en la conversación con más mensajes
(340): 0,9-6 ms; las otras dos consultas, 0,4 ms. **No se añade ningún índice** y no se toca ninguna tabla compartida.

**Falla cerrada.** Referencia ausente, corrupta, de otro contacto, fila borrada o movida, consulta fallida, cuenta sin habilitar: la condición lanza
un error, la ejecución termina `failed` / `condition_evaluation_failed` (con un código en el evento) y **no se envía el seguimiento** (R09, R12).

**Marcas de tiempo.** La referencia usa el reloj de la base de datos; los mensajes entrantes traen la hora de Meta (segundos enteros). Se compara
estrictamente «posterior a la referencia», sin tolerancia: así un mensaje anterior (incluido el que disparó el flujo) nunca cuenta. Supuesto
documentado: relojes sincronizados (la VPS tiene NTP activo). Un cliente que conteste en menos de 1 s del primer mensaje queda truncado al segundo
anterior; no es una respuesta humana realista.

**Carrera «responde entre la evaluación y el envío».** Si la condición da NO, el motor guarda `vars["$reply_guard"]`; **antes de cada envío**
posterior (`send_message`, `send_media`, `collect_input`, `send_buttons`, `send_list`) vuelve a hacer la misma pregunta. Si el cliente escribió en
el intervalo, no se envía, la ejecución termina `completed` / `customer_replied_before_send` (R10). SÍ desactiva la guarda (la rama «respondió» puede
enviar un mensaje). **Límite irreducible:** si el cliente responde durante la propia llamada a Meta (decenas de ms después de la última comprobación)
el seguimiento sale igualmente; se envía una sola vez y nada se duplica (R11). Ningún diseño local puede cerrar esa ventana.

**Flag y seguridad.**
* `FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS` (vacío por defecto, UUID separados por coma, solo servidor): autoría (PUT `/api/flows/[id]` → 403
  `customer_reply_condition_disabled`; `/api/flows/capabilities` → `customerReplyCondition`; el editor solo ofrece «Actividad del cliente» si el servidor lo dijo).
* Activación: bloqueada igual que las esperas. El validador exige `durableWaitExecution` (422), la API responde 409 si la cuenta no tiene el flag, y el motor
  **falla cerrado** al evaluar si faltan el flag de la condición **o** el de ejecución de esperas. Sin migración no hay trigger SQL: un `UPDATE flows SET status='active'`
  directo sobre un flujo que solo tenga esta condición no lo bloquea la base, pero el motor se detiene antes de enviar nada tras la condición.
* `GET /api/flows/downgrade-compatibility` informa `BLOCKED_BY_CUSTOMER_REPLY_CONDITIONS` y `customer_reply_condition_flow_ids`. Una imagen anterior (P6/P5)
  trata el sujeto desconocido como campo nativo inválido y falla cerrado; por eso conviene no tener flujos activos con la condición antes de volver atrás.
* Las demás cuentas conservan el editor y los flujos (el motor solo añade un recorrido en memoria de los nodos de la ejecución y una lectura de `run.vars`; cero consultas nuevas sin condición).

**Editor.** «Si… → Actividad del cliente» (solo con el flag), selector del **mensaje de referencia** (pasos de enviar de ese flujo), texto fijo «el cliente respondió
después del mensaje de referencia» y ramas «SÍ, el cliente respondió → avanzar a» / «NO, el cliente no respondió → avanzar a». Traducciones es/en/ko. Resumen en el nodo:
«el cliente respondió después de <paso>». Las condiciones existentes no cambian.

**F06 (futuro).** `subject_key` sigue siendo la clave del nodo. El intérprete versionado deberá resolver la referencia desde el `flow_run_effects` **confirmado**
de ese nodo (`provider_message_id` → fila `messages`) en lugar de `vars["$refs"]`, y reutilizar la misma pregunta de evaluación y la misma guarda. No se mezcla
con el motor legacy ni se aplican 052-066 desde P7.

## 2. Mensajes durante la espera (Etapa 4)
Se conserva: el webhook guarda el mensaje (Inbox) y luego llama al motor; durante una espera el motor registra `reply_received {during_wait:true}` y devuelve `consumed:false`, así
que Inbox, automatizaciones por palabra clave y la respuesta automática de IA (si la cuenta la tiene activa) siguen viéndolo. P7 no cambia webhooks ni enrutamiento.
Análisis de conflictos (no se modificó ninguna política compartida):
* Seguimiento del flujo + respuesta de automatización/IA: **no chocan** porque, si el cliente respondió, la condición cancela el seguimiento (R02). Quedan una respuesta de la automatización/IA, no dos.
* **Punto a decidir antes de habilitar ejecución:** si la rama SÍ envía un mensaje propio *y* la IA o una automatización ya contestó en el minuto 5, el cliente recibiría dos respuestas
  comerciales. Recomendación: la rama SÍ de Pilot termina sin enviar (lo pedido). Pilot hoy tiene 0 automatizaciones activas; falta confirmar, en solo lectura, su configuración de IA.
* Un mensaje de IA/automatización es `bot` y no pausa la ejecución ni cuenta como respuesta: coherente. Un mensaje de un agente sí pausa la ejecución (`paused_by_agent`) y por tanto cancela el seguimiento.

## 3. Pruebas
* `npm test`: **2067 pasan**, 28 omitidas (las de PostgreSQL/PostgREST); `tsc` limpio; lint 0 errores, 48 avisos (la misma línea base).
* Nuevas unitarias: referencia (ida y vuelta, primer envío, corrupta), flag, validador, informe de downgrade, rutas PUT/activar, formulario del editor (guardar/recargar/editar, flag apagado, sin pasos de envío, regresión de las otras condiciones).
* `qa/customer-reply/run-engine-qa.sh [--e4-migrations <dir>]` (motor real + PostgreSQL 17 desechable + PostgREST aislado, sin red, envíos simulados que escriben la fila `bot`): **R01-R14 PASS** (19 pruebas),
  con solo `main`+067-069 y con E4 052-066 antes de 067-069. Casos: 13 min sin respuesta = NO; respuesta al minuto 5 = SÍ; respuesta inmediata antes de programar la espera = SÍ; botón/lista/imagen/audio/ubicación/documento = SÍ;
  agente y bot no cuentan; mensajes anteriores no cuentan; otro contacto u otra cuenta no cuentan; reinicio conserva la referencia; 8 modos de falla = sin seguimiento; respuesta entre condición y envío = suprimido;
  respuesta durante la llamada a Meta = límite documentado; flags; referencia explícita con varios mensajes; 0 envíos reales.
* `qa/durable-wait/run-engine-qa.sh` (P6, E01-E12) sigue pasando sin cambios.
* No hay migraciones nuevas: la compatibilidad 067-069 / E4 se prueba por el orden de migraciones del runner y por la ausencia de objetos SQL nuevos.

## 4. Qué resuelve P7 y qué no (Etapa 7: ventana de pérdida)
| | Qué garantiza | Evidencia |
|---|---|---|
| **P7 resuelve** | Referencia persistente del primer envío; consulta barata y acotada a cuenta/contacto; falla cerrada; guarda antes del envío; autoría solo para cuentas autorizadas | R01-R14 |
| **No resuelve** | Pérdida si el proceso muere entre el consumo de la espera y el primer envío (el seguimiento no sale; nunca se duplica) | P6 E09b, sin cambios |
| **No resuelve** | Incertidumbre si Meta aceptó el mensaje y el proceso muere antes de anotarlo | P6 E09c |
| **No resuelve** | Respuesta del cliente durante la llamada a Meta | R11 |

**Garantías ante reinicio o fallo (solo lo demostrado):** la espera se reclama y se consume una sola vez; la referencia y la guarda sobreviven al reinicio; una falla de la condición no envía nada; un seguimiento no se duplica.
**No se afirma «exactamente una vez»:** WhatsApp Cloud API no ofrece clave de idempotencia (así lo documenta también la migración 059 de E4).

**Opciones evaluadas para la ventana consumo → envío** (decisión pendiente antes de habilitar ejecución real):
* (A) *Detector de ejecuciones varadas* (activas, sin espera, en un nodo de envío, sin avance en N min): reanuda **solo si no hay `message_sent` posterior al consumo**. Sin migraciones; deja la incertidumbre del paso 4. Es la opción de menor riesgo para el legacy.
* (B) *Libro de efectos tipo F06* (`flow_run_effects`, 059-064: `pending → claimed → confirmed/failed/ambiguous`, un envío ambiguo **nunca** se reenvía solo): da at-most-once con detección, no exactly-once; requiere migraciones y reescribir el recorrido legacy. Mejor hacerlo al integrar F06, no antes.
* (C) *Aceptar la pérdida documentada* para el caso de bajo valor (un seguimiento de venta): medir primero la frecuencia real de caídas.
Recomendación: aceptar (C) para el piloto con una ejecución autorizada y medir; implementar (A) antes de abrir a más cuentas; (B) con F06. Cualquier opción exige decisión del propietario del negocio.

**Antes de habilitar ejecución real:** decisión sobre la ventana (A/B/C); confirmar la política de respuestas durante la espera y la IA de Pilot; una ejecución real autorizada con contacto de prueba; instalar el cron por minuto y poner el id de Pilot en `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` (con orden explícita); rotar los secretos del HANDOFF si procede.

## 5. Plan de despliegue P7 (requiere tu autorización; no ejecutado)
Impacto: **sin migraciones**, sin tablas compartidas modificadas, sin cambios en scheduler/cron. Cambia solo la imagen de la app (`docker-compose.p7.yml`, override nuevo; p6/p5/p4/e3 se conservan) y una variable en `.env.local`.
1. Preflight: imagen actual = `wacrm-app:p6-candidate-<sha>` sana; línea base en `<backup-dir>/` (flujos por cuenta, hash de nodos, WhatsApp, errores, flags sin valores).
2. Respaldo `pg_dump -Fc` + sha256 + restauración de prueba en contenedor aislado (aunque no haya migración, por regla); copia de `.env.local` y compose.
3. Ensayo: no hay migraciones que ensayar; se repiten `run-engine-qa.sh` (R01-R14) y la suite completa sobre el commit exacto.
4. Imagen inmutable desde `git archive` del commit (limpio, sin `docs/` ni `.env*`), etiqueta `p7-candidate-<sha12>` con la revisión como etiqueta de imagen.
5. `.env.local`: añadir **solo** `FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS=<account_id de Pilot leído de la base>`. No tocar `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` (sigue sin existir).
6. `up -d --no-deps app`; verificar healthy, `/login` 200, `/api/flows/capabilities` sin sesión 401, los borradores de la cuenta piloto, otras cuentas sin cambios, 0 esperas, 0 ejecuciones, logs sin errores nuevos.
7. Rollback: volver a `docker-compose.p6.yml` y quitar la variable. Antes, consultar `downgrade-compatibility` (si Pilot ya guardó flujos con la condición, P6 los tratará fallando cerrado; son borradores y no se pueden activar).
8. Confirmar que la ejecución sigue deshabilitada: flag de ejecución inexistente, cron por minuto no instalado, F04/F06 apagados.

## 6. Guía de QA manual para Pilot (tras el despliegue)
Entrar a la app con la cuenta piloto y abrir un flujo en **borrador** (no usar contactos reales):
1. Agregar nodos: **Enviar mensaje** («Información de la hidrolavadora») → **Retraso** (Espera, 13 minutos) → **Si / sino**.
2. En **Si / sino** elegir «Actividad del cliente». Debe aparecer «Mensaje de referencia»: elegir el primer *Enviar mensaje*. El texto «el cliente respondió después del mensaje de referencia» es fijo (no hay operador ni valor).
3. «SÍ, el cliente respondió → avanzar a»: un nodo **Fin**. «NO, el cliente no respondió → avanzar a»: un **Enviar mensaje** de seguimiento. **Guardar**.
4. Recargar (F5): el nodo muestra «el cliente respondió después de <paso>», la referencia y las dos ramas siguen igual; el Retraso sigue en «13 minutos».
5. Cambiar la referencia a otro envío, guardar, recargar; cambiar el tipo a «Etiqueta» y volver a «Actividad del cliente»: la referencia se pide de nuevo (no se arrastra un valor viejo).
6. Intentar **Activar**: debe rechazarse (la ejecución no está habilitada). Ejecuciones sigue en 0.
7. Con otra cuenta (no Pilot): «Actividad del cliente» **no** aparece en el desplegable; las condiciones de siempre funcionan igual.
