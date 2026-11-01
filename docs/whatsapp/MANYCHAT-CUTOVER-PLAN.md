# Corte de ManyChat → WACRM para el número comercial (plan, sin ejecutar)

**Estado:** documento de preparación. **No se ha ejecutado nada de lo que describe.** Cada fase del corte requiere autorización expresa e independiente.
Documento público: usa marcadores (`<PHONE_NUMBER_ID>`, `<MESSAGING_ACCOUNT_ID>`, `<WABA_ANTERIOR>`, `<CUENTA_DESTINO>`) y no contiene cifras de negocio, nombres de clientes ni secretos. Contexto técnico: `MESSAGING-ACCOUNT-COMPATIBILITY.md`.

## 1. Principios

1. **Nada irreversible hasta el último paso.** Quitar a ManyChat como socio (y su línea de crédito) es el punto sin retorno; todo lo anterior se puede deshacer.
2. **Jamás** eliminar el número, la cuenta de WhatsApp ni la WABA, ni pulsar «desconectar» en ManyChat con la opción que borre/desregistre el número (confirmarlo por escrito con ManyChat antes).
3. **Una sola voz por conversación:** durante todo el procedimiento, un mensaje entrante no puede disparar a la vez un flow de ManyChat y uno de WACRM.
4. Lorteg y Alexis Test no se tocan. Las variables `MANYCHAT_*` del servidor pertenecen al puente de **otra** cuenta y no se modifican.

## 2. Bloqueos (deben estar resueltos antes de pedir el corte)

| # | Bloqueo | Quién | Evidencia que cierra el bloqueo |
|---|---|---|---|
| B1 | **Advertencia de Meta «posible restricción de envío hasta el 1-dic-2026»** al administrar el acceso de ManyChat. Sin fuente oficial localizada | Propietario del portafolio + soporte de Meta | Respuesta **escrita** de Meta (qué la dispara, qué operaciones afecta, si aplica al cambiar de proveedor, si hace falta soporte) |
| B2 | **Facturación independiente no demostrada** | Propietario + WACRM (lectura) | Cargo de un envío de plantilla de marketing visible en la cuenta de mensajería nueva (Facturación y pagos), y actividad de esa plantilla en la analítica de Graph de la cuenta nueva y **no** en la anterior |
| B3 | Token propio de la cuenta destino (hoy compartido con otra cuenta de WACRM) | Propietario (Meta) + WACRM | Token nuevo del mismo usuario de sistema y app, cifrado dentro del contenedor, probado en lectura; el anterior no se revoca |
| B4 | Exportación completa de ManyChat y respaldo (sección 4) | Propietario | Archivos verificados (recuento y muestra) y copia cifrada fuera del servidor |
| B5 | Selección y prueba de los flows que se reactivarán (sección 5) | Propietario + WACRM | Lista cerrada de flows por oleada, probados con contactos de prueba |
| B6 | Plantillas de la cuenta nueva (las de la cuenta anterior **no se copian solas**) | Propietario (Meta) | Plantillas necesarias aprobadas en la cuenta nueva; la calidad copiada se reinicia (2–4 semanas) |
| B7 | Verificación de negocio del portafolio (hoy limita la salud de envío de la cuenta de WhatsApp) | Propietario | Estado verificado, o decisión documentada de proceder sin ella |
| B8 | Ventana y personal de guardia acordados | Propietario | Ventana en la franja de menor tráfico y alguien con acceso a ambas plataformas durante todo el procedimiento |

## 3. Dependencias con ManyChat

**Dentro de WACRM (para la cuenta destino): ninguna.** Sus envíos siempre usan Meta (`resolveOutboundTransport` solo elige ManyChat para la cuenta del puente). El puente de ManyChat pertenece a otra cuenta y sigue intacto.

**Fuera de WACRM (hay que reemplazarlas o retirarlas):**

1. Los flows conversacionales y las palabras clave que atienden al cliente en el número.
2. La base de contactos, etiquetas, campos personalizados y el historial de conversaciones.
3. **Pedidos hacia InkaClick:** hoy los pedidos confirmados en ManyChat llegan por su webhook al receptor de InkaClick (origen `manychat`). Tras el corte, los pedidos se confirman con «Confirmar pedido» en WACRM y la entrega automática (origen `wacrm`). Hasta entonces los dos orígenes coexisten sin chocar (claves de duplicado distintas); al cortar, ManyChat deja de enviar.
4. Difusiones, secuencias y automatizaciones programadas de ManyChat.
5. Su suscripción de webhooks, su acceso de socio y su línea de crédito en la cuenta de WhatsApp.
6. Otros canales conectados a ManyChat (si existen) y cualquier integración externa que lea o escriba en ManyChat.

## 4. Respaldo y exportación (solo lectura sobre ManyChat)

1. **Respaldo de WACRM** (cifrado + restauración verificada en contenedor aislado) antes de importar nada.
2. **Contactos:** exportar la audiencia completa de ManyChat (CSV) con teléfono, nombre, etiquetas, campos personalizados y fechas de última interacción. Registrar el recuento exacto.
3. **Etiquetas y campos personalizados:** inventario con nombres y tipos. Crear en WACRM los que falten **antes** de importar; los flows que se reactiven dependen de los campos personalizados por identificador.
4. **Conversaciones:** exportar lo que ManyChat permita (transcripciones/historial por contacto, si existe esa opción) y, si no existe una exportación masiva, **mantener ManyChat en solo lectura** durante un periodo acordado después del corte. No prometer historial completo en WACRM.
5. **Importación a la cuenta destino** (después del respaldo y fuera de la ventana de corte): con una muestra pequeña primero (≈20 contactos); verificar teléfonos normalizados, deduplicación contra los contactos existentes, etiquetas y campos. La importación **no envía mensajes**.
6. Anotar lo que **no** se migra (estado interno de flows en curso, métricas, secuencias) y avisar a quien lo use.

## 5. Selección de flows (no reactivar los 299 sin criterio)

Hechos medibles de la cuenta destino (consultables en lectura): cuántos flows hay, cuántos se han ejecutado alguna vez, tipos de nodos, palabras clave compartidas entre flows (si dos flows comparten palabra clave, gana el más antiguo), flows con variables literales no soportadas y flows con subflujos.

Criterios, en orden:

1. **Equivalencia con ManyChat:** solo se reactiva un flow que tenga un equivalente activo hoy en ManyChat (lista exportada de sus automatizaciones y palabras clave). Un flow sin equivalente se queda en borrador.
2. **Colisiones:** resolver las palabras clave compartidas (dejar un solo ganador intencional) antes de activar.
3. **Variables:** ningún flow con variables literales sin mapear.
4. **Dependencias:** subflujos (`execute_flow`), esperas, audios de producto y campos personalizados verificados con un contacto de prueba.
5. **Oleadas:** (1) flows de entrada y de prueba; (2) un departamento/producto de bajo riesgo; (3) el resto por volumen. Cada oleada con su prueba y su ventana de observación.

Procedimiento técnico de activación (cuando se autorice): lista cerrada de identificadores, transacción protegida con recuento esperado y, en el momento, `UPDATE flows SET status='active'` solo sobre esa lista. Reversión: la misma lista a `draft`. La instantánea de los flows que estaban activos antes de la pausa se conserva en el respaldo.

## 6. Orden exacto del corte (ventana de menor tráfico)

**T-24 h a T-1 h (preparación, sin cambios de cara al cliente)**
1. Confirmar B1–B8 por escrito. Respaldo fresco de WACRM + estado de ManyChat (capturas de automatizaciones activas).
2. Importar contactos y etiquetas (sección 4). Probar la oleada 1 con contactos de prueba **en un ensayo con ManyChat en pausa solo para el contacto de prueba** (si ManyChat lo permite), o con una palabra clave exclusiva de prueba.
3. Dejar abiertas dos pantallas: bandeja de la cuenta destino y analítica de entregas.

**Ventana (T-0)**
4. **ManyChat:** pausar/desactivar las automatizaciones y respuestas por defecto del número (no desconectar el canal). Verificar que un mensaje de prueba **no** recibe respuesta de ManyChat.
5. **WACRM:** activar la oleada 1 (inmediatamente después de 4, para minimizar el hueco). Probar: mensaje entrante → flow → respuesta con atribución a la cuenta de mensajería nueva.
6. Observar 30 minutos: entrantes, respuestas, fallos de envío (cero), duplicados (cero), errores de aplicación, cron de pedidos en `OK`, pedido de prueba confirmado y entregado a InkaClick.
7. Activar las oleadas siguientes con la misma comprobación entre una y otra.

**T+1 h a T+72 h (convivencia con ManyChat en pausa, no retirado)**
8. Vigilancia con el listado de comprobaciones de la sección 7. ManyChat sigue vinculado y suscrito, pero sin automatizaciones: es el seguro de reversión.

**Retirada (otra autorización, tras la estabilidad acordada y B1 resuelto)**
9. **Suscripción de ManyChat:** desvincular su app de la cuenta de WhatsApp anterior (desde su producto o retirando el acceso de socio, según confirme ManyChat por escrito).
10. **Línea de crédito de ManyChat:** retirarla de la cuenta de WhatsApp anterior; confirmar que la facturación propia (tarjeta de la cuenta de mensajería nueva) está activa **antes**.
11. **Acceso de socio:** eliminar a ManyChat de Socios en el portafolio, **sin** eliminar el número, la cuenta de WhatsApp ni la WABA, y sin la opción de ManyChat que desregistra números.
12. Comprobar a continuación: el número sigue `CONNECTED`, la app propia sigue suscrita, un envío y una recepción reales, y la facturación en la cuenta nueva.

## 7. Comprobaciones durante y después (solo lectura)

- Estado del número y calidad (Graph); suscripciones de ambas cuentas de mensajería; analítica de la cuenta nueva (enviados/entregados) frente a la anterior.
- Mensajes salientes por tipo y estado desde la hora de corte; **cero** `failed`; **cero** duplicados (mismo contacto, mismo texto, <1 min).
- Flows: ejecuciones por flow, motivos de fin, corridas atascadas; cron de flows y de pedidos en `OK`.
- Aplicación sana, sin reinicios, sin errores relevantes en aplicación, webhook ni base de datos; Lorteg y Alexis Test sin cambios.

## 8. Rollback y sus límites reales

| Momento | Cómo volver | Límite |
|---|---|---|
| Antes del paso 4 | No hay nada que deshacer | — |
| Pasos 4–8 | Pausar los flows activados (misma lista a `draft`) y **reactivar las automatizaciones de ManyChat**; la app propia puede seguir suscrita sin responder | Mensajes recibidos durante el hueco sin respuesta; contactos/etiquetas creados en WACRM durante la ventana no vuelven a ManyChat |
| Pasos 9–10 (suscripción y crédito retirados, socio aún presente) | Volver a vincular la app de ManyChat y su línea de crédito desde ManyChat | Depende de que ManyChat permita revincular; probarlo antes si es posible |
| Paso 11 (**sin retorno práctico**) | Solo volviendo a conectar el número a ManyChat mediante su alta de socio y su línea de crédito | Es un procedimiento nuevo con aprobación de Meta; puede haber interrupción. Por eso el paso 11 se hace al final y con B1 resuelto |
| En cualquier momento | La suscripción de la app propia se puede quitar sin afectar a ManyChat | Dejaría de recibirse en WACRM |

## 9. Recomendación

**NO-GO** hasta cerrar B1 y B2 (y B3–B8). El envío y la entrega por la cuenta nueva están validados; la atribución está respaldada por la analítica de Meta; la **facturación** de un envío cobrable y el aviso de Meta siguen sin demostrar.
