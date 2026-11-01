# Corte operativo reversible ManyChat → WACRM: runbook y preflight (preparado, NO ejecutado)

Complementa `MANYCHAT-CUTOVER-PLAN.md`. Repo público: sin identificadores ni cifras de negocio; las listas exactas de flows viven en la custodia privada del operador.
Herramientas probadas en base desechable: `scripts/ops/cutover/flows-set-status.sql` (activar/pausar una lista exacta de flows) y `scripts/ops/cutover/cutover-watch.sql` (vigilancia de solo lectura). QA: `scripts/qa/cutover/run.sh` (33 comprobaciones).

## 1. Preflight (todo debe estar en PASS; un solo FAIL crítico detiene el corte)

| # | Condición | Cómo se comprueba |
|---|---|---|
| P1 | Cuenta destino operativa: número `CONNECTED`, app propia suscrita a la cuenta de mensajería nueva, recepción y envío reales | Lecturas de Graph + mensajes recientes |
| P2 | Facturación independiente: actividad de **marketing con coste** atribuida a la cuenta de mensajería nueva y **no** a la anterior; tarjeta propia activa | Analítica de precios (Graph) + Facturación y pagos (manual) |
| P3 | **Equivalencia comprobada** de cada flow de la oleada con una automatización de ManyChat que hoy responde | Inventario de ManyChat (sección 3) revisado por el propietario |
| P4 | **Cobertura:** todo lo que hoy recibe respuesta automática en ManyChat queda cubierto por la oleada, o se acepta por escrito qué dejará de responderse | Comparación inventario ↔ oleada |
| P5 | Palabras clave de la oleada sin colisiones con otros flows | Consulta de solapamientos |
| P6 | Todo sub-flow llamado por la oleada está **dentro** de la oleada (un sub-flow en borrador falla en ejecución) | Guarda del script |
| P7 | Pedidos: «Confirmar pedido» y la entrega automática a InkaClick activos, vendedores dados de alta como miembros, pedido controlado definido | Sección 5 |
| P8 | Respaldo cifrado de WACRM con restauración verificada y lista de flows de la oleada guardada | Procedimiento de respaldo habitual |
| P9 | Ventana y personal de guardia con acceso a **ambas** plataformas | Acuerdo escrito |
| P10 | Rollback ensayado (sección 6) | `scripts/qa/cutover/run.sh` + ensayo en ManyChat |
| P11 | Advertencia de Meta del 1-dic: **no bloquea** un corte operativo que no toca el acceso de socio; **sí bloquea** la retirada definitiva hasta tener respuesta escrita de Meta | Ticket de Meta |

## 2. Por qué la convivencia no puede ser parcial «a ciegas»

Con ManyChat activo, **todo** mensaje entrante llega a ambas plataformas. Una respuesta por defecto o una automatización de ManyChat que siga encendida responde también a los mensajes que ya atiende un flow de WACRM. Y al revés: al pausar la respuesta por defecto de ManyChat, todo lo que **no** cubra WACRM se queda sin respuesta. Por eso:

1. el corte **no** se hace con una oleada que no cubra los productos/anuncios realmente activos (P4), y
2. la pausa en ManyChat y la activación en WACRM se hacen seguidas, en la franja de menor tráfico, con vigilancia continua.

## 3. Inventario de ManyChat a revisar (sin exportación general)

Pantallas a abrir en ManyChat (los nombres pueden variar según la versión; anotar «no existe» si no aparece):

1. **Automatización → Flows:** lista con estado (publicado/borrador), disparadores y último uso. Marcar los que disparan por palabra clave o por **anuncio que abre WhatsApp**.
2. **Respuesta por defecto** y **mensaje de bienvenida** del canal WhatsApp.
3. **Reglas/Rules** y cualquier automatización por etiqueta o evento (incluidas las de espera).
4. **Secuencias** y **difusiones programadas** con envíos pendientes.
5. **Asignación en chat en vivo:** reglas de asignación automática de conversaciones a vendedores.
6. **Integraciones/Webhooks:** peticiones externas que envían pedidos u otros datos (en especial la que envía pedidos confirmados a InkaClick) y cualquier Zapier/API.
7. **Canales adicionales** conectados (otros números, Instagram, Messenger), por si comparten flows.

Entregar, por cada automatización activa: nombre, disparador (palabras clave o anuncio), ¿responde a clientes?, ¿asigna?, ¿envía pedidos?, usos en los últimos 7 días, ¿imprescindible? (sí/no). Con eso se construye la matriz de equivalencias contra los flows de WACRM; **no se declara equivalente lo que no se haya comparado**.

## 4. Ejecución del corte (solo con autorización final)

0. **Guardar el estado previo:** `flows-status-before` (recuentos) y la lista de la oleada en la custodia privada.
1. **Verificar** que la vigilancia funciona (`cutover-watch.sql` en vacío) y abrir las dos plataformas.
2. **ManyChat:** pausar/despublicar las automatizaciones del inventario que puedan responder (flows, respuesta por defecto, bienvenida, reglas, secuencias, difusiones programadas, asignación automática). **No** desconectar el canal, **no** tocar el acceso de socio ni la línea de crédito. Anotar la hora.
3. **Comprobar que ManyChat calla:** mensaje de prueba desde un teléfono de prueba con una palabra clave que ManyChat atendía: no debe llegar ninguna respuesta de ManyChat.
4. **WACRM, inmediatamente:** activar la oleada con el script (los sub-flows primero o en la misma lista; la guarda lo verifica):
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
     -v account_id=<CUENTA_DESTINO> -v from_status=draft -v to_status=active \
     -v flow_ids="$(cat <lista-privada.csv>)" -v expected=<N> \
     < scripts/ops/cutover/flows-set-status.sql      # responde FLOWS_SET_ACTIVE rows=<N>
   ```
5. **Probar:** palabra clave de la oleada → respuesta del flow (una sola); mensaje fuera de la oleada → respuesta humana o ninguna (según P4); atención manual desde la bandeja; un **pedido controlado** (sección 5).
6. **Vigilar** cada 3–5 minutos durante la ventana acordada:
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 \
     -v account_id=<CUENTA_DESTINO> -v since='<hora de inicio, UTC>' -v silence_minutes=3 \
     < scripts/ops/cutover/cutover-watch.sql
   ```
   Cualquier línea `ALERT` (fallos de envío, respuestas duplicadas, mensajes sin responder, corridas fallidas o atascadas) detiene la ventana. Además: app sana, cron de pedidos en `OK`, sin errores en aplicación, webhook ni base de datos.
7. **Criterio de éxito:** 0 fallos, 0 duplicados, 0 mensajes sin responder por encima del umbral, pedido controlado entregado a InkaClick, y la ventana completa sin alertas.

## 5. Pedidos: sustitución del proceso de ManyChat

- «Confirmar pedido» (Inbox) está habilitado para la cuenta destino; la entrega automática a InkaClick está activa y vigilada por el monitor de pedidos.
- Los **vendedores** son miembros de la cuenta: quien deba aparecer como vendedor debe tener usuario en la cuenta destino (hoy puede haber pocos). Esto sustituye a la asignación comercial **manual** al confirmar; **no** reemplaza una asignación automática de ManyChat (si existe, es un hueco a decidir).
- Un pedido de prueba llega a InkaClick como real (WACRM no marca `is_test`): marcarlo después en InkaClick y avisar a logística. Los dos pedidos antiguos retenidos (`held`) no se liberan.
- Hasta la retirada de ManyChat, el webhook de pedidos de ManyChat debe quedar **pausado junto con sus flows** para no duplicar pedidos.

## 6. Rollback (probado en lo que depende de WACRM)

1. **WACRM:** pausar la misma lista (`from_status=active`, `to_status=draft`, misma lista y mismo recuento). Estado resultante idéntico al previo (probado).
2. **ManyChat:** volver a publicar exactamente las automatizaciones que se pausaron (inventario con hora) y comprobar con un mensaje de prueba.
3. Mantener la suscripción de la app propia (no estorba) o quitarla solo si hace falta.
4. Límites: los mensajes recibidos durante el hueco sin respuesta no se recuperan; los contactos y etiquetas creados en WACRM no vuelven a ManyChat; el estado interno de conversaciones de ManyChat en curso puede haberse reiniciado.

## 7. Retirada definitiva de ManyChat (preparada, NO ejecutar sin autorización independiente)

Precondiciones: estabilidad acordada tras la ventana, facturación propia verificada en Facturación y pagos, respuesta escrita de Meta a la advertencia del 1-dic, confirmación por escrito de ManyChat de que su «desconectar» no desregistra ni borra el número.

1. **Suscripción de ManyChat:** desvincular su app de la cuenta de WhatsApp anterior (desde ManyChat o retirando su acceso, según confirme ManyChat). Verificar por lectura: la cuenta anterior ya no lista a ManyChat; la cuenta nueva sigue con la app propia.
2. **Línea de crédito de ManyChat:** retirarla **después** de comprobar que la tarjeta propia está activa. Verificar en Facturación y pagos.
3. **Acceso de socio:** eliminar a ManyChat de Socios **sin** eliminar el número, la cuenta de WhatsApp ni la WABA, ni registrar de nuevo el teléfono.
4. **Verificación posterior:** número `CONNECTED`, calidad, app propia suscrita, un envío y una recepción reales, analítica de la cuenta nueva, cron de pedidos `OK`, Lorteg y Alexis Test sin cambios.

Este paso es el punto sin retorno práctico (ver `MANYCHAT-CUTOVER-PLAN.md`, sección 8).
