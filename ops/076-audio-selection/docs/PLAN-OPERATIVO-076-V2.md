# Plan operativo de la migración 076 (revisión 2 del procedimiento)

> **Estado:** la migración 076 **ya está aplicada en producción** (23-oct-2026, ver `ACTA-APLICACION-PRODUCCION-076.md`). Este plan queda como **runbook** para otros entornos (staging, restauraciones, nuevas instalaciones) y como referencia del procedimiento. **No debe volver a ejecutarse `apply` en producción**: el pre-vuelo exige que 076 esté ausente.

## Qué cambia 076 y qué no
Cambia: 2 tablas nuevas vacías, 8 columnas NULL, 1 índice único parcial, 19 restricciones, 2 políticas RLS, 2 triggers, 7 funciones solo `service_role` (SECURITY INVOKER). No cambia: ninguna fila, función o permiso existente, ninguna imagen, variable ni Flow. La imagen anterior sigue funcionando antes, durante y después.

## Scripts (carpeta `audio-guide/produccion-076/`)
| Script | SHA-256 | Función |
|---|---|---|
| `aplicar-076-v2.sh` | `0cd3f66a4681e7c1e11ef04bdafcff34203155a481ce5a89a85a23d7bb775549` | `preflight` (solo lectura), `apply`, `verify` (solo lectura), `rollback` |
| (versión 1 de referencia, no versionada) | `67cf0151cd751481fdbd3b15c97e799d162ab32aefa495a3eda6378dd903dad5` | sustituida por la v2 |
| `test-aplicar-076.sh` | ensayo del propio procedimiento en una base sintética (15 escenarios) | |
| `test-respaldo-vigencia-076.sh` | revalidación del respaldo (10 escenarios) | |
| `test-rls-permisos-076.sh` | RLS y EXECUTE con roles reales (9 pruebas) | |

**Cambio de la v2 respecto a la v1:** el respaldo se revalida (mismo archivo, vigente, mismo SHA-256, restauración de prueba aprobada 8/8) justo después de encontrar el hueco tranquilo y antes de cada intento de la transacción. Si venció, desapareció, cambió o perdió su evidencia, es **NO-GO** (código 3) y no se aplica nada. El `rollback` no está sujeto a la edad del respaldo.

## Secuencia
1. **Respaldo completo con restauración de prueba** (`pg_dump -Fc` + restauración en una red interna + comparación de catálogo, ACL/RLS, extensiones, conteos y roles). Vigencia máxima: 90 min.
2. **Copias privadas de la configuración** en uso (`.env.local` y los archivos de Compose del contenedor), con manifiesto SHA-256, fuera del repositorio.
3. **Pre-vuelo (solo lectura):** `bash aplicar-076-v2.sh preflight` → PF01–PF10 deben ser PASS: hashes de los archivos revisados; identidad del servidor; 076 ausente y 073–075 presentes; estructura (digest y 1320 líneas), matriz de permisos y conteos iguales a los aprobados; sin sesiones bloqueantes; capacidad y aplicación sana; respaldo reciente verificado.
4. **Aplicación:** `CONFIRM_APPLY_076=yes bash aplicar-076-v2.sh apply` dentro de `tmux`. Espera un hueco de 60 s sin mensajes del bot ni ejecuciones de Flows (máximo 30 min; si no aparece, aborta sin cambiar nada), revalida el respaldo, aplica en **una sola transacción** con `lock_timeout` 3 s y `statement_timeout` 30 s (hasta 3 intentos, solo ante bloqueo o interbloqueo, esperas de 20 y 60 s), verifica V01–V06 y observa 5 minutos (V07). Códigos de salida: 0 aplicado y verificado; 1 abortó sin cambios o falló una verificación posterior; 3 NO-GO por el respaldo.
5. **Verificación independiente** (`verify` y el QA de `QA-POSTERIOR-076-Y-RECUPERACION.md`).

## Reversión
- Falla la migración: no hay nada que revertir (transacción única).
- Falla una verificación **sin datos nuevos**: `CONFIRM_ROLLBACK_076=yes bash aplicar-076-v2.sh rollback`.
- Problema de la aplicación: volver a la imagen anterior; no requiere tocar la base.
- **Con finalidades, identificadores, audios clasificados o solicitudes selectivas existentes: `rollback-076.sql` está prohibido** (el script se niega). Se pierde información al borrar las tablas nuevas, la clasificación de los audios y los datos de las solicitudes selectivas.

## Criterios GO / NO-GO
**GO:** ensayo PASS 46/46; contenido idéntico al ensayado; respaldo nuevo con restauración de prueba aprobada; pre-vuelo 10/10; ventana de poco tráfico y autorización escrita citando el SHA-256 del script. **NO-GO:** cualquier PF falla; sesiones bloqueantes o sin hueco en 30 min; aplicación no sana; cambió el esquema, los permisos o los conteos desde la aprobación; respaldo vencido, ausente o modificado; incidente comercial abierto.

## Referencias externas al repositorio
`aplicar-076-v2.sh` espera el SQL de la migración en `supabase/migrations/` de un clon del repositorio (variable `MIG076`) y la matriz de permisos de **producción** exportada en `MATRIX_PROD`; esa matriz es específica de cada entorno y no se versiona: se regenera ejecutando `matriz-permisos.sql` en modo solo lectura y ordenando la salida. Los valores fijados dentro del script (digest de estructura, conteos 76/76/0/0, imagen esperada) corresponden a producción el 23-oct-2026 y deben revisarse para otro entorno.
