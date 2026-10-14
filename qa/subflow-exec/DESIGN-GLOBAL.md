# P4-P8 disponibles para todas las cuentas: habilitación global

Estado: **código y pruebas listos. Etapa A (autoría global) = imagen + `FLOW_AUTHORING_SCOPE=all`. Las etapas B y C (ejecución) están preparadas y NO activadas.**

## 1. Diseño de la habilitación global
Antes había una lista de UUID por función (autoría de subflujos, esperas, condición P7, ejecución de esperas, ejecución de subflujos). Ahora hay **dos interruptores globales** en el servidor
(nunca del navegador), más la base de datos para la ejecución:

| Pieza | Qué decide | Valores |
|---|---|---|
| `FLOW_AUTHORING_SCOPE` | Quién puede **crear y guardar** (borradores): ejecutar otro flujo, esperas de minutos/horas/días, condición «Cliente respondió», referencia heredada, llamada y retorno, alcance del Fin, política ante respuesta | `all` = todas las cuentas, **incluidas las que se registren después** (sin lista); `allowlist` = solo las listas históricas (valor por defecto: el código nuevo no cambia nada hasta que se fije); `off` = nadie (interruptor de emergencia). Cualquier otro valor (`true`, `*`, un error de tipeo) cuenta como `off` |
| `FLOW_EXECUTION_SCOPE` | La mitad de **entorno** de las dos llaves para **ejecutar** | igual |
| `flow_execution_enablement` (070) + `flow_execution_defaults` (071) | La mitad de **base de datos** de las dos llaves | fila por cuenta (puede apagar o encender a una cuenta) y una fila global; **vacío / apagado por defecto**; solo un operador privilegiado escribe, `anon`/`authenticated` ni leen, `service_role` solo lee |

* Una cuenta nueva recibe la autoría por el interruptor `all` y, cuando se decida, la ejecución por la fila global de la base: **sin lista de UUID y sin tocar el ciclo de registro**.
* Los permisos por rol no cambian: guardar y activar siguen exigiendo `agent`; el aislamiento entre empresas sigue en RLS y en las RPC (probado: T19, S18, S24).
* **Flags que se generalizan:** `FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS`, `FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS`, `FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS` (→ `FLOW_AUTHORING_SCOPE`), `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS`, `FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS` (→ `FLOW_EXECUTION_SCOPE` + base de datos).
  Las listas quedan como modo `allowlist` (compatibilidad y vuelta atrás). **No se eliminan** y se pueden retirar después.
* **Flags que se conservan y NO se tocan:** `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS` (F04), `MANYCHAT_*`, `WHATSAPP_OUTBOUND_TRANSPORT`, y todo lo de F06/052-066 (probado: `all` no abre F04).
* El buscador de flujos (P5) y el guardado atómico (067) ya estaban disponibles para todas las cuentas.

## 2. Validador y editor
* El validador del editor ya no asume nada: pregunta al servidor si **esta cuenta puede ejecutar** (entorno Y base de datos) y mientras no responde no afirma nada. El mensaje antiguo
  («execute_flow nodes require versioned execution…») desapareció; si no está habilitado dice: «Ejecutar flujos conectados todavía no está habilitado para esta cuenta. Puedes seguir armando y guardando este flujo, pero no se podrá activar hasta que lo esté.»
* Mensajes específicos y traducidos (es/en/ko, probados sin referencias a F06): destino sin elegir, paso de retorno inexistente, referencia o política inválida, destino de otra cuenta / inexistente, destino que debe estar activo,
  ciclo, profundidad máxima (3), flujo llamado que nunca devuelve el control, esperas y condición no habilitadas, alcance del Fin inválido.
* Los chequeos que solo el servidor puede hacer (destino activo, misma cuenta, ciclos, profundidad) aparecen en el panel tras un intento de activar y desaparecen al editar.
* La seguridad sigue en el backend (rutas PUT/activar) y en la base de datos (068, 069, 070, 071); el editor solo informa.

## 3. Ejecución (preparada, no activada)
* Las guardas de activación y `push_flow_subflow` consultan `flow_execution_enabled(cuenta, tipo)` = fila de la cuenta, si no la fila global. Sin filas y con la global apagada, todo se comporta como hoy.
* Cron (preparado en `qa/subflow-exec/ops/`, **no instalado**, en su propio archivo de `/etc/cron.d`): esperas + recuperación cada minuto, solo contra sus dos rutas protegidas por secreto. Con el alcance por defecto responden sin tocar la base de datos.
  Con `all` atienden exactamente las cuentas que la base tiene habilitadas. El barrido compartido de 5 minutos y el cron de Automations no se tocan; el desambiguado `flows!flow_id` sigue aplicado.
* Los flujos que no usan nada de P6-P8 conservan el camino histórico de envío aunque el alcance sea global (sin registro de intención, sin marcos): S27.

## 4. Carga e índices (restauración del respaldo real: 20 019 ejecuciones, 586 772 eventos, 887 567 mensajes)
Consulta de reanudación, de recuperación, barrido compartido y lista de cuentas: submilisegundo con índices parciales ya existentes (`idx_flow_runs_waiting_due`, `idx_one_active_run_per_contact`); respuesta espontánea: `idx_flow_run_events_run_type`;
marco superior: índice único de la pila. **No hace falta ningún índice nuevo.**

## 5. Simulación sin WhatsApp (evaluación)
Pilot no tiene número conectado, y eso **no impide** crear, guardar, enlazar referencias ni validar. Para probar la lógica sin enviar nada hay tres opciones:
1. **Entorno aislado (lo que ya existe):** el arnés S01-S27 corre el motor REAL contra PostgreSQL/PostgREST desechables con un transporte falso; es la prueba de seguridad y de recorrido, pero no está al alcance del usuario final.
2. **«Probar flujo» dentro de WACRM (recomendada como P9):** un intérprete **puro en memoria** (sin base de datos, sin Meta, sin filas en `flow_runs`/`messages`, sin tocar métricas) que recorre el borrador o el flujo válido, incluidas las llamadas A→B→A→C→A, con entradas guiadas
   (el cliente responde en el minuto N / no responde / pulsa tal botón) y un reloj virtual para esperas de 13 minutos. Cada paso se etiqueta **«SIMULADO»** y la pantalla separa claramente: **borrador → flujo válido → flujo activado → ejecución simulada → ejecución real por WhatsApp**; nunca muestra «enviado».
   Riesgo a vigilar: que el simulador diverja del motor; se mitiga reutilizando `validate`, `matchReplyId`, `evaluateConditionPredicate` y la misma lógica de pila, y comparándolo en CI con las trazas del arnés S.
3. **Un contacto de prueba con el transporte de prueba:** requiere WhatsApp conectado; queda para la autorización específica de la Etapa B.
Mínimo viable: opción 2, ~un módulo puro + una ruta de solo lectura + un panel; no requiere migraciones.
