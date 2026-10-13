# Esperas duraderas en Flows: diseño

## Qué es
Un nodo `delay` con `{ amount, unit }` (segundos, minutos, horas o días; de 1 segundo a 30 días) detiene la ejecución en
`flow_runs` (`wait_until`, `wait_node_key`) y un planificador la reanuda después. El `delay` de 1-30 s sin `unit` sigue
durmiendo dentro del proceso, igual que antes. No se añade ningún tipo de nodo (la restricción `flow_nodes_node_type_check`
no cambia, así que no choca con la migración 058 de E4).

## Alternativas descartadas
| Alternativa | Por qué no |
|---|---|
| Subir el límite del `sleep()` | Vive en la memoria del proceso: se pierde al reiniciar y retiene una petición/worker |
| Cola de Automations (`automation_pending_executions`) | Atada a `automations` y sus pasos (FK); mezclaría dos motores |
| Intérprete versionado F06/E4 | No está en producción y depende de las migraciones 052-066 sin integrar. El diseño deja el camino: la espera de F06 será otro nodo propio |
| Estado `waiting` en `flow_runs.status` | Habría que tocar todas las consultas de "ejecución activa"; con `status='active'` se conserva la regla de una ejecución activa por contacto y todo lo que ya cancela ejecuciones activas (agente, bloqueo) cancela también la espera |

## Las cuatro operaciones y sus fallos
| Paso | Qué hace | Si el proceso muere aquí |
|---|---|---|
| 1 Reclamo | `claim_due_flow_waits`: un worker obtiene la espera (`FOR UPDATE SKIP LOCKED`, arrendamiento de 300 s, token aleatorio) | La espera sigue intacta; al vencer el arrendamiento otro worker la reclama. No se pierde ni se duplica |
| 2 Consumo | `consume_flow_wait`: solo el titular del token, solo si la ejecución sigue activa y vencida; limpia la espera y mueve la ejecución al siguiente nodo en **una** sentencia | Desde aquí la espera no puede reanudarse otra vez |
| 3 Avance | `advanceFromNodeKey` recorre los nodos siguientes en memoria (el motor legacy solo persiste al suspender) | **Ventana de pérdida:** si muere entre 2 y el primer envío, el seguimiento se pierde (la ejecución queda en el nodo siguiente hasta que la limpieza de ejecuciones estancadas la cierre). Nunca se duplica |
| 4 Efectos | Envío a Meta + evento | Si Meta aceptó el mensaje y el proceso muere antes de terminar el recorrido, no se puede saber qué se envió: es la misma limitación de cualquier avance legacy de varios nodos |

**No se afirma envío "exactamente una vez".** Lo demostrado: una espera se reclama y se consume exactamente una vez (carreras reales de
4 y 2 procesos); un seguimiento no se duplica; hay una ventana de pérdida (paso 3) y una de incertidumbre (paso 4). Por eso la
ejecución sigue deshabilitada (`FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` vacío) hasta que se acepten esas ventanas.

## Respuestas del cliente durante la espera
La webhook guarda el mensaje (Inbox/agentes) **antes** de llamar al motor. Mientras la ejecución espera, el motor:
* registra `reply_received` con `during_wait: true` (sin guardar el texto) y la idempotencia de Meta sigue funcionando;
* **no** ejecuta la política de respaldo (reprompt/handoff), que antes habría podido agotarse y terminar la ejecución;
* devuelve `consumed: false`: el flujo no se queda con el mensaje, por lo que las automatizaciones por palabra clave siguen viéndolo
  (decisión a confirmar antes de habilitar la ejecución).
La futura condición «Cliente respondió» no necesita comparar textos: basta preguntar si existe un mensaje de cliente en la conversación
posterior al envío (`messages.created_at > flow_runs.last_advanced_at` del momento en que se agendó la espera) o un evento
`reply_received` con `during_wait` de esa ejecución. No se implementa en esta fase.

## Precisión, costo y carga
* El cron actual corre cada 5 minutos: una espera de 13 min se reanudaría entre 13 y 18. Por eso la reanudación vive en un endpoint
  **propio** (`/api/flows/waits/cron`) pensado para llamarse **cada minuto** sin multiplicar por cinco el barrido compartido de
  `/api/flows/cron` (que recorre todas las ejecuciones activas). Precisión esperada: entre el vencimiento y 60 s después (13 min -> 13:00-14:00), más el tiempo de envío.
* Costo en reposo: **cero llamadas a la base de datos** mientras la lista de ejecución esté vacía (responde `{"enabled":false}`). Habilitada:
  una consulta con índice parcial (`idx_flow_runs_waiting_due`, 8 KB hoy) por minuto.
* Límite por lote: 25 por defecto (máximo 200, `?limit=`), presupuesto de 45 s por pasada. Con carga, las más antiguas salen primero y el
  resto espera a la siguiente pasada (≈ `limit` reanudaciones/min; cada una hace al menos un envío a Meta).
* Los worker concurrentes son seguros (SKIP LOCKED + token): una pasada lenta no bloquea ni duplica a la siguiente.
* La limpieza de ejecuciones estancadas (`/api/flows/cron`) mide la antigüedad desde el vencimiento de la espera, no desde que empezó.

## Compatibilidad con E4/F06
* Migración 069: solo columnas nuevas con prefijo `wait_`, índice, tres funciones y dos triggers con `WHEN`. Probada en tres órdenes con 052-066.
* Si un runner anterior (P5/E3) ejecutara un flujo activo con espera duradera dormiría como máximo 30 s: por eso la activación está
  prohibida (API, validador y base de datos) y el informe de downgrade (`BLOCKED_BY_DURABLE_WAITS`) lista flujos y ejecuciones en espera.
