# Requisitos registrados antes de habilitar la ejecución real de esperas

La ejecución sigue deshabilitada (`FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` vacío, cron por minuto sin instalar, activación bloqueada en
validador, API y base de datos). No se habilita hasta cumplir estos dos requisitos y obtener una ejecución real autorizada.

## 1. Condición «Cliente respondió desde el primer mensaje enviado» (cancelar seguimientos)
* Objetivo: tras enviar la información del producto y esperar (p. ej. 13 minutos), enviar el seguimiento **solo si el cliente no respondió**.
* Referencia temporal: el envío de la información del producto (el momento en que se agenda la espera: `flow_runs.last_advanced_at` en
  `schedule_flow_wait`, o el evento `message_sent` del nodo anterior). Se evalúa **solo con mensajes posteriores** a esa referencia.
* Consulta barata, sin comparar listas de textos: existe un mensaje `sender_type='customer'` de la conversación con
  `created_at > referencia`, o un evento `reply_received` con `during_wait=true` de esa ejecución (ya se registra desde P6).
* Decisión pendiente: qué hace el flujo si respondió (terminar, ramificar con un nodo `condition`, o pasar a un agente) y si una respuesta
  durante la espera debe cancelar la espera antes de tiempo o solo evaluarse al vencer.
* Decisión pendiente (heredada de DESIGN.md): durante la espera el flujo devuelve `consumed: false`, así que las automatizaciones por palabra
  clave siguen viendo el mensaje; confirmar que es lo deseado para Pilot.

## 2. Ventana de pérdida entre consumir la espera y completar el envío
* Hoy: `consume_flow_wait` limpia la espera y mueve la ejecución al nodo siguiente en una sentencia; el recorrido de nodos corre después en
  memoria. Si el proceso muere entre ambos, el seguimiento **se pierde** (nunca se duplica) y la ejecución queda en el nodo siguiente hasta que
  la limpieza de estancadas la cierre. Ver DESIGN.md (pasos 2-4) y la prueba E09.
* Opciones a evaluar: (a) detector de ejecuciones «varadas» (activas, sin espera, en un nodo auto-avanzable, sin avance en N minutos) que
  reanude **solo si no hay evidencia de envío** (evento `message_sent` posterior al consumo), aceptando que el límite es la incertidumbre del
  paso 4; (b) persistir el progreso por nodo y usar la clave de idempotencia de Meta para los envíos; (c) aceptar la pérdida documentada para
  los casos de bajo valor.
* Criterio para habilitar: ventana medida (frecuencia real de caídas entre consumo y envío), decisión explícita del propietario del
  negocio y pruebas de fallo para la opción elegida.
