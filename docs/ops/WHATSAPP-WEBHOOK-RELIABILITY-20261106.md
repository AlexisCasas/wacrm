# WhatsCRM — Auditoría de webhooks y plan de resiliencia

**Fecha del incidente:** 2026-11-06, 13:48:32–13:48:43 UTC.  
**Estado:** propuesta de trabajo; ningún correctivo implementado.  
**Línea base:** `main` desde `5d3dae2a5bddf77e7cd63ef31d7046503045de2f`.  
**Alcance:** Meta WhatsApp Cloud API, actualización de estados, recepción duradera, despliegues de app. No afecta pedidos/InkaClick ni datos productivos hasta aprobación por separado.

## 1. Hechos establecidos y límites de la auditoría

- Durante el reemplazo de la imagen de `app`, Caddy registró **60 HTTP 502** en 10,4 segundos: **57 intentos** de webhook, **2** acciones de contactos y **1** envío.
- Los 57 intentos representan **14 payloads distintos**, con 2–5 reintentos cada uno. No son 57 mensajes perdidos.
- **1 evento entrante recuperado** tiene respaldo independiente; **13 payloads quedaron indeterminados** y no pueden clasificarse individualmente como entregados o perdidos. El contenido del webhook no estaba registrado en un diario durable.
- Las acciones de contactos fueron repetidas por el asesor y el estado final resultó consistente; el envío fallido no se persistió en la app. La correspondencia de un mensaje posterior con ese intento es indeterminada.
- No se observaron duplicados, fallos de Flows ni pérdidas comerciales confirmadas. Eso **no prueba ausencia de pérdidas**: los estados de mensajes podrían quedar desactualizados.
- Docker envió SIGTERM al contenedor antiguo aproximadamente a las 13:48:31.98 UTC, cerró su puerto pronto y aplicó SIGKILL tras el timeout de 10 s. Lo que mantuvo vivo Next hasta el SIGKILL **no se identificó**. Desde el final del corte no hubo nuevos 5xx atribuidos al reemplazo.
- La app está estable tras el despliegue de la búsqueda de catálogo; no se justifica un rollback reactivo por esta auditoría.

**Privacidad:** conservar únicamente evidencias anonimizadas. No ingresar IPs, identificadores de contactos, cuerpos Meta, firmas, teléfonos, credenciales ni datos de clientes en GitHub, reportes o logs de QA.

## 2. Hallazgos confirmados en el código de `main`

### H1 — ACK anterior a la persistencia duradera (riesgo de pérdida)

En `src/app/api/whatsapp/webhook/route.ts`, el POST valida la firma por cuenta, hace `after(async () => processWebhook(body))` y responde **200** antes de confirmar que los eventos fueron almacenados y procesados. `after()` no es una cola durable: el SIGKILL del proceso, una caída o un error posterior al ACK pueden dejar eventos aceptados sin reintento desde Meta. El comentario que dice que `after()` garantiza completar el trabajo debe precisarse para el despliegue real en VPS.

### H2 — Actualización de estado sin aislamiento suficiente ni orden monótono

`handleStatusUpdate()` ejecuta `.from('messages').update({ status: status.status }).eq('message_id', status.id)`. El código declara que `message_id` **no es único** entre números y admite coincidencias múltiples. Sin restricción al número/cuenta de origen, podría actualizar filas ajenas si hubiera una colisión. También admite retrocesos de estado por reentregas fuera de orden. La consulta posterior `.limit(1)` para escoger un destino de notificación no demuestra pertenencia al tenant correcto.

**Esto es un riesgo potencial, no un incidente intercuenta confirmado.** Se necesita reproducir con datos sintéticos de múltiples cuentas antes de modificar la lógica.

### H3 — Reemplazo de app sin drenaje verificable

El procedimiento actual detiene el único upstream de Caddy, espera diez segundos y lo fuerza si sigue ocupado, dejando aproximadamente diez segundos sin aceptar conexiones. Elevar `stop_grace_period` puede proteger trabajo en curso, pero **sin una segunda instancia y un plan de enrutamiento empeoraría la duración del 502**.

## 3. Orden de implementación (cada etapa requiere PR y QA propios)

### PR-A / P0 — Restringir las actualizaciones de estado por tenant y volverlas monótonas

1. Determinar de manera confiable `account_id`, `phone_number_id` y referencia de mensaje del payload **firmado**; no fiarse de datos editables por clientes.
2. Actualizar exclusivamente el mensaje de la cuenta/número validado. Si la identificación es ambigua, registrar sin cambiar otras cuentas y generar alerta estructurada.
3. Aplicar transiciones monotónicas de `pending → sent → delivered → read` con política explícita para `failed`, sin retrocesos ante reentregas antiguas. Hacer la validación atómica ante concurrencia, no solo `SELECT` seguido de `UPDATE`.
4. Emitir notificación externa solamente para un cambio válido y efectivo, en la cuenta correcta; deduplicar eventos si corresponde.
5. Probar colisiones sintéticas de `message_id` entre cuentas, timestamps invertidos, varias workers, estados repetidos y `failed` tardío. Mantener compatibilidad con Flows, envíos y broadcasts.

**Gate:** cero actualizaciones y notificaciones cruzadas entre cuentas; cero retrocesos bajo concurrencia y reintentos.

### PR-B / P0 — Bandeja de entrada durable para webhooks antes del HTTP 200

1. Verificar firma HMAC con secret del tenant y resolver identidad de cuenta antes de escritura.
2. Persistir una recepción `pending` en una transacción **antes del HTTP 200**. Si no se confirma la escritura, no responder 200. Mantener deduplicación por tenant y clave de evento; considerar payloads con varios eventos y eventos sin identificadores únicos.
3. Guardar lo mínimo necesario para reprocesar: contrato de datos, retención limitada, protección de contenido, privilegios mínimos, RLS donde aplique y prohibición de PII en logs.
4. Implementar worker durable con reclamo transaccional, lease, backoff, límite de intentos, estados `received / processing / completed / retry / dead-letter`, métricas y mecanismo de recuperación.
5. Auditar **todos** los efectos posteriores: inserción de mensajes, contactos, unread, Flows, automatizaciones, IA, multimedia, entregas externas; comprobar idempotencia real de acciones, no solamente de `messages`.
6. Cuidar que el worker no dependa de un proceso `app` que se detiene antes de drenar o de una tarea `after()` no persistida. Hacer rollout observe/canary, sin interrumpir la ruta vigente hasta probarla.
7. Probar cortes de proceso antes de guardar, tras guardar y después del ACK; caídas entre efectos, duplicados, burst, multi-tenant y replay fuera de orden.

**Gate:** todo evento respondido con 200 puede localizarse y reprocesarse; aceptación duradera demostrada con SIGKILL y concurrencia; cero acciones externas duplicadas.

### PR-C / P1 — Despliegue sin interrupción, validado antes de adoptarlo

**No implementar aún conmutación de alias Docker como si fuera failover garantizado.** Un alias compartido con dos IPs no implica que Caddy seleccione un backend sano, ni que reintente con seguridad una solicitud POST. Evitar también el falso supuesto de que `--scale app=2` elimina por sí solo la ventana de errores.

1. Diseñar dos instancias con alias propios y **ruta de selección explícita** o proxy interno controlado, en lugar de depender exclusivamente del orden de respuestas DNS. Evitar cambios involuntarios en el Caddy compartido con otros proyectos.
2. Arrancar `green`, comprobar su salud desde la red del proxy, su configuración y su conectividad a DB **sin procesar crons duplicados**.
3. Demostrar con pruebas aisladas cómo cambian conexiones activas, HTTP keepalive y POSTs cuando se retira `blue`. No forzar cierre antes de drenar.
4. Revisar los scripts de host que usan `CONTAINER="wacrm-app-1"` (pedidos, automatizaciones, Flows y monitores) y definir un destino estable o marcador transaccional. Verificar que no se ejecuta el cron simultáneamente en ambas instancias.
5. Definir `stop_grace_period` tras medir las tareas `after()` y su tiempo máximo. No usar una espera fija sin métrica de conexiones o tareas pendientes.
6. Garantizar migraciones hacia atrás compatibles durante convivencia de dos versiones, rollback por enrutamiento y retención verificable de la imagen anterior.
7. Prueba aislada: tráfico HTTP y webhooks POST continuo, varias conmutaciones consecutivas, conexiones lentas y posibles fallos de DNS/backend. Medir tasa de errores, pérdidas, duplicados y latencia.

**Gate:** 0 respuestas 5xx y 0 pérdidas/duplicados bajo pruebas de despliegue repetido; rollback verificado sin tocar DB; sin afectar servicios vecinos. Si no se demuestra, mantener ventana de bajo tráfico y drenaje planificado.

## 4. Protocolo de decisión

- **Ahora:** no cambiar runtime, Supabase, Compose, Caddy, flags, Webhooks ni cron; completar QA visual pendiente de catálogo de Keyler de forma separada, sin confirmar pedidos de prueba.
- **Primero:** implementar PR-A y su QA multi-tenant, luego PR-B con base durable y replay; ambas mitigaciones evitan depender de una futura topología blue/green para integridad.
- **Después:** validar PR-C en red/DB aisladas y desplegar solamente al cumplir sus gates.
- **Rollback:** por PR, funcional y operativo; nunca asumir que restaurar la imagen revierte una nueva migración de datos.
- **Seguimiento:** anomalías sin soporte de evidencia quedan INDETERMINADAS; no declarar incidentes cerrados como completamente conciliados.

**Nota:** este documento es una propuesta de ingeniería creada para revisión. No constituye aprobación de cambios productivos.
