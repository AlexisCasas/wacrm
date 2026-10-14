# Etapa B: ejecución real controlada (PLAN; nada de esto está aplicado)

Principio: **la primera prueba habilita UNA empresa** con las dos llaves existentes. `FLOW_EXECUTION_SCOPE=all` y el valor global de la base de datos (071) **no se tocan** hasta la Etapa C.

## 1. Estado real (comprobado en solo lectura)
* Producción: imagen `wacrm-app:p9-candidate-<sha>` (commit `05585f82`), sana. `FLOW_AUTHORING_SCOPE=all`. No existen `FLOW_EXECUTION_SCOPE`, ni las listas de ejecución, ni las de F04; `MANYCHAT_AI_AUTOREPLY_ENABLED=false`, transporte `meta`.
* Base de datos: migraciones hasta 051 + 067-070. **071 no aplicada.** `flow_execution_enablement`: 0 filas. 0 ejecuciones activas, 0 esperas.
* Cron: `/etc/cron.d/wacrm` con su única entrada (cada 5 min); los cron por minuto no están instalados.
* Empresas: `bbbbbbbb` (WhatsApp conectado, 25 flujos activos, 1 borrador, **sin** configuración de IA, **0** automatizaciones activas, ninguna conversación con agente asignado);
  `cccccccc` (WhatsApp conectado, 67 flujos activos; IA configurada con respuesta automática **apagada**; 1 automatización activa, de tipo `tag_added`);
  Pilot `aaaaaaaa` (sin WhatsApp, 243 borradores).
* QA automatizado sobre el commit de producción (+ los dos casos nuevos de esta preparación): ver el resumen del informe.

## 2. Plan de aplicación de la 071 (con el valor global APAGADO)
071 crea `flow_execution_defaults` con **una fila apagada**, dos funciones (`flow_execution_enabled`, `enabled_execution_account_ids`) y reemplaza tres funciones (guardas 068/069 y `push_flow_subflow`) para que consulten esas funciones. Sin filas por cuenta y con el valor global apagado el comportamiento es **idéntico al de hoy**.
Ensayada sobre restauraciones del respaldo real: 110 ms, hashes de flujos/nodos idénticos, `defaults = false/false`.
Pasos (requieren tu orden explícita):
1. Preflight: línea base (flujos, nodos, ejecuciones, WhatsApp, errores, flags sin valores); 0 ejecuciones activas; imagen P9 sana.
2. Respaldo `pg_dump -Fc` + sha256 + restauración de prueba + ensayo de la 071 sobre esa copia.
3. `docker exec -i supabase-db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/071_flow_execution_defaults.sql` (una transacción). **No hay que recrear la app**: la imagen P9 ya usa `flow_execution_enabled()` cuando existe y cae al valor por fila cuando no.
4. Verificar: `flow_execution_defaults` = 1 fila `false/false`; `flow_execution_enablement` = 0 filas; `anon`/`authenticated` sin acceso a las tablas ni a las funciones; por la API: `service_role` puede leer pero no insertar (403), `anon` recibe 401/404.
5. Verificar que nada cambió: flujos/nodos idénticos, `/api/flows/cron` 200, ninguna ejecución nueva.
**Rollback:** `qa/subflow-exec/rollback-071.sql` (ya probado: deja las tres funciones como en 070, borra lo de 071 y la suite T01-T11 vuelve a pasar). Es seguro en cualquier momento porque la 071 no habilita nada por sí sola.

## 3. Instalación de los dos cron por minuto
Archivos preparados (no instalados) en `qa/subflow-exec/ops/`: `wacrm-flows-1min-cron.sh` (llama solo a `/api/flows/waits/cron` y `/api/flows/recovery/cron` con el secreto que ya está en el contenedor), `cron.d-wacrm-flows.example` y `logrotate-wacrm-flows.example`.
* **Permisos:** script `root:root 0750` en `/usr/local/bin` (igual que el existente), archivo de cron `root:root 0644` en **su propio** `/etc/cron.d/wacrm-flows` (no se edita `/etc/cron.d/wacrm`), `flock -n` para no acumular pasadas, log propio con rotación semanal (el log actual de 2 MB no rota).
* **Protección de rutas:** ambas exigen el secreto (401 sin él; verificado en producción) y responden `{"enabled":false}` **sin tocar la base de datos** mientras no haya una cuenta habilitada.
* **Rendimiento (restauración del respaldo real: 20 019 ejecuciones, 586 772 eventos):** reanudación, recuperación, barrido compartido y lista de cuentas tardan submilisegundo o pocos ms con índices existentes; no hace falta ningún índice nuevo. Con una sola empresa son 2 llamadas HTTP locales y 2-3 consultas pequeñas por minuto.
* **Concurrencia y recuperación (probadas):** reclamo con arrendamiento y token (T12-T14, S14), dos recuperadores (S16), reinicio de la aplicación (S13), consumo-y-caída (S15), intención sin confirmación = no se reenvía (S15, S21).
* **Orden:** se instalan **después** de habilitar la empresa piloto y **antes** de la prueba (la espera de 13 minutos se reanuda sola). Verificación: dos pasadas con `{"enabled":true,...,"claimed":0}`, sin errores, `/api/flows/cron` y el cron de Automations siguen con su cadencia de 5 minutos.
* **Rollback:** borrar `/etc/cron.d/wacrm-flows` (efecto inmediato). Las esperas ya programadas quedan vencidas hasta que se reinstale o las cierre el barrido de 24 h.

## 4. Habilitar UNA sola empresa (procedimiento)
Dos llaves independientes; **ninguna** del tipo global:
1. **Base de datos (la decide un operador privilegiado):** `INSERT INTO public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution, note) VALUES ('<id de la empresa piloto>', true, true, 'piloto Etapa B');` ejecutado con `supabase_admin`. Nadie más puede escribir esa tabla (probado: T01, T19, T20).
2. **Entorno:** en `.env.local` añadir **solo** `FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS=<id>` y `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS=<id>` (el modo por defecto `allowlist` lee esas listas) y recrear solo la app (`up -d --no-deps app`). `FLOW_EXECUTION_SCOPE` **no se define**.
3. El valor global de la 071 queda `false/false`.
Demostrado en el arnés (S28): con esta configuración la empresa piloto activa y ejecuta A→B→A→C→A; otra empresa, una empresa creada después, y una empresa listada solo en el entorno **no** pueden activar flujos con subflujos ni con esperas (la base de datos lo rechaza); los cron atienden solo al piloto; borrar la fila del piloto detiene las llamadas nuevas de inmediato (T17, S28).
Los flujos históricos no se modifican: ni la habilitación activa nada por sí sola ni los flujos sin `execute_flow`/espera/condición cambian de comportamiento (S27).

## 5. Empresa, número y contacto de prueba (a confirmar por ti)
* **Empresa candidata:** `bbbbbbbb`: tiene WhatsApp conectado, **sin IA y sin automatizaciones de mensajes** (no habría respuestas duplicadas) y es la única conectada que no es un cliente externo. Pilot no puede (sin WhatsApp). `cccccccc` es un cliente real con 67 flujos activos: **no** debe ser la primera.
* **Contacto:** un contacto cuyo número sea **tuyo**, creado en esa empresa, sin ejecución activa, no bloqueado, sin agente asignado; con la conversación abierta (WhatsApp solo permite mensajes libres dentro de las 24 h posteriores a que el cliente escriba: la prueba empieza cuando ese número escribe la palabra clave).
* **Disparador:** una palabra clave **única** (p. ej. `prueba-p8`) que no exista en ninguno de los 25 flujos activos; A, B y C se crean nuevos (A activo con esa palabra clave, B y C **manuales**). Nada de los flujos existentes se activa ni se edita.
* **Tope de mensajes por corrida:** 4 (información, seguimiento de B, mensaje de C, cierre de A); si el cliente responde: 1.
* **Configuración de IA y Automations para evitar duplicados:** en la empresa piloto no debe existir configuración de IA con respuesta automática activa ni automatizaciones `new_message_received` / `keyword_match` (hoy: ninguna). Durante una espera el flujo devuelve el mensaje a Automations/IA; por eso, para la prueba, la conversación de prueba debe tener la IA desactivada (`ai_autoreply_disabled`) aunque se active IA más adelante. La rama «respondió» de B termina sin enviar (política `stop`).

## 6. Escenarios reales (todos con tu número)
1. **No responde:** escribes la palabra clave → recibes la información → no contestas → a los 13 min (hasta ~14) llega el seguimiento → mensaje de C → cierre de A. Esperado: 4 mensajes, 1 ejecución, sin marcos al final.
2. **Responde al minuto 5:** escribes cualquier texto → no llega seguimiento, C ni cierre; el mensaje queda en el Inbox.
3. **Agente humano:** un agente responde desde el Inbox durante la espera → la ejecución queda `paused_by_agent` y no sale nada más.
4. **Reinicio:** se recrea la app a mitad de la espera (con tu orden) → la espera se reanuda sola.
5. **Resultado ambiguo de Meta:** **no se provoca contra Meta real** (no es seguro ni determinista). Está demostrado en el arnés (S15 intención sin confirmación → `send_outcome_unknown`, nunca reenviado; S21; S22). En producción se vigila el evento `send_outcome_unknown` tras la prueba.
Cada escenario se supervisa en vivo (ejecución, eventos, mensajes) y, si algo se desvía, se detiene borrando la fila de habilitación.

## 7. Riesgos y rollback de la Etapa B
| Riesgo | Mitigación / rollback |
|---|---|
| Duplicado o pérdida por caída entre aceptación de Meta y registro | Intención previa + no reenviar ambiguos; sin garantía de «exactamente una vez» (WhatsApp no ofrece clave de idempotencia). Evidencia: S14-S16, S21 |
| Cliente responde en la fracción de segundo de la llamada a Meta | Residual irreducible; el seguimiento sale una sola vez (R11) |
| Editar A o B con una ejecución suspendida | La ejecución termina `failed` sin enviar (S07, S08): no editar los flujos de prueba durante la espera |
| IA/Automations responden al mensaje espontáneo | Config. de §5; la política `stop` evita el seguimiento del flujo |
| Fin por defecto en B/C corta todo | Configurar «regresar al flujo que lo llamó» (el panel avisa al activar A) |
| Cron nuevos | Archivo propio, se borra para revertir; sin efecto con la lista vacía |
| Rollback completo | Borrar la fila + quitar las dos variables y recrear la app + borrar el cron; la 071 se revierte con `rollback-071.sql`; la imagen P8 (`docker-compose.p8.yml`) sigue disponible. `downgrade-compatibility` informa flujos/ejecuciones afectados antes de cualquier vuelta atrás |

## 8. Orden recomendado hasta habilitar todas las empresas
1. Aplicar la 071 (valor global apagado).
2. Habilitar **solo** `bbbbbbbb` (fila + listas) e instalar los dos cron.
3. Ejecutar los escenarios 1-4 con tu número; revisar eventos, `send_outcome_unknown` y logs durante unos días de uso normal.
4. Con WhatsApp ya conectado, **Pilot** como segunda empresa (misma receta, su propia fila).
5. **Company B / `cccccccc`** solo con su aceptación y una conversación de prueba propia; su IA sigue apagada.
6. Cuando haya al menos dos empresas estables: valor global de la 071 en `true` **y** `FLOW_EXECUTION_SCOPE=all` (los dos a la vez, con presentación previa de impacto). Las filas por empresa siguen permitiendo apagar una empresa concreta.
7. Retirar las listas de entorno (`allowlist`) cuando ya no hagan falta.
Disponibilidad no es activación: ningún flujo existente se activa solo; cada empresa activa los suyos.

## 9. Simulador «Probar flujo» (diseño mínimo, sin migraciones)
**Objetivo:** probar la lógica (mensajes, esperas con reloj virtual, respuestas, condiciones, llamadas y retornos) **sin Meta, sin contactos productivos, sin métricas y sin filas reales**.
* **Un solo conjunto de reglas.** El riesgo es crear un segundo motor. Se evita en dos pasos:
  1. Extraer del motor a un módulo **puro** (sin base de datos ni Meta) las decisiones que hoy están dentro del recorrido: avance automático / suspensión / terminal, plantillas `{{vars}}`, `matchReplyId`, predicado de condición, ventana de «respondió» (segundo de referencia + ids previos), decisión de llamada (profundidad 3, ciclos, presupuesto 8), decisión del Fin (`scope`), política `stop`/`continue`. El motor real y el simulador las **importan**; el motor sigue teniendo su propio recorrido con E/S real.
  2. **Pruebas de paridad:** los mismos guiones (S01, S02, S06, S10…) se ejecutan en el simulador y en el arnés de PostgreSQL desechable; se comparan las trazas normalizadas (mensajes en orden, estado final, motivo de fin). Si divergen, falla la CI.
* **Dónde corre:** `POST /api/flows/[id]/simulate`, rol `agent`, **solo lectura**: lee los grafos con el cliente de la sesión (RLS: no puede alcanzar flujos de otra empresa), jamás usa el cliente administrativo, no importa `meta-send`, `messages` ni contactos, y no escribe en ninguna tabla. Cada petición es una simulación en memoria con límite de pasos y de tiempo.
* **Entradas del guion:** respuestas del cliente (minuto, texto / botón / imagen), agente que toma el control (minuto), contacto bloqueado, valores supuestos de etiquetas y campos del contacto de prueba (un contacto sintético «Contacto de prueba»). El reloj es virtual (13 minutos se simulan al instante).
* **Salida y presentación:** una línea de tiempo donde **cada** evento lleva la etiqueta **SIMULADO**; los mensajes se muestran como «mensaje que se enviaría», **nunca** como enviado. La pantalla distingue siempre los cinco estados: **Borrador → Flujo válido → Flujo activado → Ejecución simulada → Ejecución real por WhatsApp**; el simulador solo produce el cuarto y nunca habla del quinto.
* **Alcance mínimo viable:** módulo puro + ruta de solo lectura + panel con guion y línea de tiempo (A→B→A→C→A incluido). Sin migraciones, sin cron, sin flags nuevos (disponible cuando haya autoría). Fuera de alcance: simular formatos multimedia reales, métricas y transporte.
