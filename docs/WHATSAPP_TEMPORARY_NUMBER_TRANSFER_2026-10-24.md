# WACRM — transferencia temporal de numero WhatsApp entre cuentas

**Fecha del caso:** 2026-10-24  
**Estado del traslado:** CERRADO — transferencia y recepcion real verificadas  
**Estado del retorno:** PREPARADO, no ejecutado  
**Alcance:** operacion temporal sobre una misma instancia WACRM. No es una capacidad de multiasignacion simultanea del numero.

> Documento publicable: intencionadamente no contiene numero de telefono, IDs de cuentas/usuarios, tokens, claves, PIN, rutas de archivos protegidos, capturas con datos personales ni contenido de respaldos. El registro de auditoria detallado y los artefactos de recuperacion quedan exclusivamente en custodia operativa privada.

## 1. Objetivo y decision

Permitir que un numero de pruebas previamente vinculado a una cuenta piloto se utilice temporalmente desde una segunda cuenta para evaluar sus flujos y automatizaciones. Conservar la posibilidad de devolver la conexion a la cuenta original sin mover historiales, contactos ni definiciones de flows.

**Decision tecnica:** reasignar la fila existente de configuracion de WhatsApp entre cuentas, tras auditoria y backup, en vez de duplicar la configuracion, eliminarla mediante la UI o registrar otra vez el numero ante Meta.

Motivo: WACRM exige un unico propietario por numero. El webhook resuelve el destinatario por **phone_number_id** y despacha mensajes usando la pertenencia **account_id**; duplicar configuraciones puede impedir el enrutamiento correcto.

Referencias de implementacion:

- src/app/api/whatsapp/config/route.ts (rechazo HTTP 409 si otro tenant posee el numero).
- src/app/api/whatsapp/webhook/route.ts (resolucion por phone_number_id; rechazo si existen duplicados).
- src/lib/whatsapp/webhook-tenant-secret.ts (resolucion de secretos para verificar la firma).
- src/lib/whatsapp/send-message.ts (envio saliente ligado a account_id).
- supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql (unicidad por numero).
- supabase/migrations/017_account_sharing.sql (configuracion unica por cuenta y acceso RLS).

## 2. Resultado observado el 24 de octubre de 2026

La siguiente evidencia es la facilitada por el operador que ejecuto el procedimiento en la VPS, complementada con una prueba manual en la interfaz:

| Control | Resultado |
| --- | --- |
| Auditoria del despliegue y del esquema real | PASS, segun informe del operador |
| Respaldo cifrado, checksums y restauracion aislada | PASS, segun informe del operador |
| Transferencia de la misma fila en transaccion | PASS, una fila afectada, segun informe |
| Numero asociado solo a la cuenta temporal | PASS, una fila por numero; origen sin configuracion |
| Meta: numero conectado y aplicacion suscrita | PASS, segun comprobaciones del operador |
| Salud del contenedor y ausencia de errores criticos posteriores | PASS, segun informe |
| Mensaje real entrante visible en la bandeja de la cuenta temporal | **PASS**, comprobado manualmente en la interfaz |
| Mensaje saliente desde la bandeja | NO ACREDITADO en este cierre |
| Ejecucion de flows y audios por producto | FUERA DE ALCANCE; pruebas pendientes en entregable separado |
| Script de retorno | Preparado y ensayado en seco; **no ejecutado en produccion** |
| Copia adicional del respaldo fuera de la VPS | NO ACREDITADA; recomendada |

**Interpretacion del cierre:** esta completado el traspaso temporal y se comprobo el circuito entrante real. No debe comunicarse como validacion integral de flows, audios ni envio saliente.

**Cambios realizados, segun informe:** solo se ajustaron el propietario de cuenta y el usuario de auditoria de la configuracion; el campo de fecha de actualizacion cambio por trigger. Se conservo la identidad de la fila y los secretos cifrados. No se aplicaron migraciones, despliegues ni reinicios para el traslado.

## 3. Procedimiento reutilizable — preparacion

1. Identificar inequívocamente **cuenta origen**, **cuenta destino**, usuario responsable y numero mediante consultas de solo lectura. No inferir IDs por nombre o captura.
2. Confirmar que la cuenta destino no tiene otra configuracion de WhatsApp. Confirmar que el numero aparece **exactamente una vez** y pertenece al origen.
3. Verificar despliegue efectivo (commit/imagen), estructura y restricciones de la tabla, triggers, RLS, consumidores del campo de auditoria y cifrado compatible.
4. Revisar flows activos, mensajes pendientes, difusiones, esperas y procesos que puedan enviar durante la maniobra. Detener o aplazar el traslado si existe actividad en conflicto.
5. Crear un backup consistente de la base, mas una copia separada de la configuracion original con sus datos cifrados y un manifiesto privado de identificadores.
6. Cifrar y restringir permisos de los backups. Guardar la clave de recuperacion separadamente del archivo de respaldo; preparar una copia **fuera del mismo servidor** y probar recuperacion.
7. Validar checksum y restauracion aislada, incluido acceso a extensiones/esquemas requeridos. Ensayar en seco los scripts de ida y vuelta contra un entorno aislado con el esquema real.
8. Establecer ventana operativa, plan de pruebas y criterios de abortar.

**Regla:** sin respaldo recuperable y rollback ensayado, **NO-GO**.

## 4. Ejecucion — solo operador autorizado

1. Revalidar que el numero sigue asignado al origen y que el destino continua sin configuracion.
2. Aplicar el script privado previamente revisado en **una sola transaccion**, con bloqueo de fila, timeout, validaciones de pertenencia y exigencia de **exactamente una fila** afectada.
3. Reasignar exclusivamente los campos de pertenencia y auditoria imprescindibles de la fila existente. No duplicar ni cambiar valores cifrados.
4. Volver a consultar para comprobar origen sin esa configuracion, destino con una sola, e inexistencia de duplicados por numero.
5. Comprobar metadatos de Meta, suscripcion a webhooks, validez de firma y salud/logs de la aplicacion.
6. Verificar manualmente un mensaje entrante real y, preferentemente, uno saliente. Registrar resultados sin publicar contenido personal del chat.
7. Si hay error critico, usar el plan privado de retorno solo despues de verificar sus precondiciones. No desactivar constraints ni RLS; no improvisar DELETE/INSERT.

**No recomendado:** usar «Reset Configuration» en la interfaz, copiar tokens entre tenants, duplicar filas, publicar SQL con IDs reales ni restaurar toda la base como primer recurso.

## 5. Retorno futuro — cuenta temporal a cuenta original

**Estado actual:** retorno preparado; su ejecucion productiva queda pendiente para cuando termine la ventana de pruebas.

Antes de retornar:

1. Confirmar con el responsable que las pruebas en la cuenta temporal terminaron.
2. Revisar workflows/flows activos, difusiones, mensajes pendientes y esperas de esa cuenta; evitar mensajes a mitad de ejecucion.
3. Hacer un nuevo respaldo del estado actual y preservar los resultados de las pruebas.
4. Confirmar que el numero sigue perteneciendo a la cuenta temporal y que la cuenta original no tiene una configuracion nueva o incompatible.
5. Revisar y ejecutar el **script privado de rollback**, con sus bloqueos, comprobaciones de propietarios y validacion de una sola fila.
6. Comprobar que la configuracion retorna a la cuenta original y desaparece de la temporal.
7. Validar Meta, webhook, mensaje entrante, mensaje saliente y estado de salud de WACRM.
8. Conservar en su cuenta los historiales, contactos, flows y resultados creados durante las pruebas. **No restaurar una copia completa de la base** para revertir solo la propiedad del numero.

**Criterio de cierre del retorno:** una unica cuenta propietaria, Meta y webhook correctos, mensajes reales de entrada y salida verificados, y sin regresiones en las demas cuentas.

## 6. Custodia y seguridad

- No versionar en Git respaldos, contraseñas, archivos .env, capturas con PII ni scripts que contengan IDs productivos o datos cifrados recuperables.
- El rollback operativo y el manifiesto de identificadores se custodian en directorios de acceso restringido de la infraestructura, no en este repositorio publico.
- Tener respaldo y clave exclusivamente en el mismo servidor deja riesgo ante perdida o compromiso de la VPS; obtener copia cifrada externa con llave separada y verificarla.
- Documentar fecha, responsable, checksum y resultado de restauracion en el registro privado.
- Revalidar el comportamiento en la **version desplegada**, no solo en main: en este caso el operador reporto una diferencia entre el directorio de trabajo y la imagen activa.

## 7. Pendientes separados del traslado

- Prueba real de mensaje saliente desde la bandeja de la cuenta temporal.
- Activar y probar al menos un Flow controlado.
- Validar rutas/condiciones, seleccion de producto y audios asociados.
- Comprobar continuidad e historial de la conversacion y ausencia de errores.
- Completar copia externa segura del backup y guardar su evidencia privada.
- Cuando corresponda, ejecutar y verificar el retorno en produccion.

Estas tareas no invalidan el cierre del **traslado**, pero impiden declarar completo el piloto funcional de la cuenta temporal o el **retorno**.

## 8. Criterios de cierre y siguiente uso

**Traslado:** CERRADO (2026-10-24), con recepcion entrante real comprobada.  
**Piloto funcional de flows/audios:** PENDIENTE, gestionar por separado.  
**Retorno a la cuenta origen:** PENDIENTE de ejecucion, con procedimiento preparado y probado en seco.

Cuando se quiera reutilizar este procedimiento, el operador debe primero confirmar que el esquema, el cifrado, los consumidores de configuracion y las politicas de cuenta **no han cambiado** respecto a la version auditada.
