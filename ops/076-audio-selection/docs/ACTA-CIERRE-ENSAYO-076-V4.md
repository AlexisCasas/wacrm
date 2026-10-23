# Acta de cierre del ensayo 076 V4 (fase 1B)

> **Nota posterior (23-oct-2026, 06:30Z):** esta acta describe el estado *antes* de aplicar la migración. La migración 076 se aplicó después en producción: ver `ACTA-APLICACION-PRODUCCION-076.md`. Las frases «no está aplicada en ningún entorno real» y «producción: sin cambios» eran ciertas al cerrar el ensayo y ya no lo son. Se conserva el texto original sin más cambios.

**Fecha:** 23-oct-2026. **Estado:** ensayo CERRADO, resultado PASS. **Producción: sin cambios.** La migración 076 no está aplicada en ningún entorno real.

## 1. Qué se ensayó
La migración `076_audio_guide_selection.sql` (PR #38, commit `985b18e1`, SHA-256 `4588d86b…c461`) sobre una copia aislada de la base real: esquema `public` completo (46 tablas, 74 funciones, 34 triggers, 115 políticas) y los datos de las cuatro tablas `audio_guide_*` (76 productos, 76 audios, 0 solicitudes, 0 envíos), en un PostgreSQL 17.6 sin red ni puertos, destruido al terminar.

## 2. Resultado y auditoría del informe
`/opt/wacrm-ensayo-076/resultado-ensayo-v4-20261023T050005Z.txt` (SHA-256 `84a97fe6…8c07`): **46 PASS, 0 FAIL**, EXIT 0.
- Las 46 verificaciones obligatorias aparecen **exactamente una vez**, sin duplicados ni «MISSING».
- Sin falsos PASS: las huellas tenían contenido (1366 líneas, 4 hashes, 46 conteos); D03 contó 22 columnas, 19 restricciones, 7 índices, 7 funciones, 2 políticas y 2 triggers añadidos; los controles S01/S02 probaron que el comparador rechaza vacíos y detecta cambios de un valor; el self-test sintético (7/7) probó que B07 falla ante cualquier discrepancia de permisos.
- Cobertura: restauración (B01–B07, con la matriz de permisos idéntica a producción), aplicación en una transacción (0,19 s), datos originales idénticos (D01), nada anterior cambiado (D02), solo objetos de 076 (D03/D04), verificador `verify-schema.sql` (D07), comportamiento con filas reales (F00–F20), reversión exacta (G01), reaplicación idéntica (G02) y verificador tras reaplicar (G03).

## 3. Historia de los intentos (para que no se reutilice nada erróneo)
| Ejecución | Resultado | Causa |
|---|---|---|
| Original (04:29Z) | 35 PASS / 6 FAIL | `psql -f` leía una ruta del host dentro del contenedor → huellas vacías → 5 falsos PASS |
| V2 (04:36Z) | se detuvo en FP-before | `text || "char"` ambiguo en PG 17.6; la huella de datos no devolvía filas para tablas vacías |
| V3 (04:42Z) | 43 PASS / 2 FAIL | la copia daba más permisos que producción (permisos automáticos de la imagen) → D07/G03 |
| **V4 (05:00Z)** | **46 PASS / 0 FAIL** | matriz de permisos idéntica a producción (B07) |
Los informes anteriores no se usan como evidencia de aprobación.

## 4. Integridad de archivos (SHA-256)
| Archivo | SHA-256 |
|---|---|
| `esquema-public.sql` (exportado) | `aace71498716a189e2e8c3690382f97f6e44d0074c08a7d5892801e41a0c7827` |
| `datos-audio-guide.sql` (exportado) | `61294f3d605528ca53050bae5545ecd5d349d288936f2db81f789c9f71709127` |
| `matriz-permisos-prod.txt` | `43d20a85435f9f698e68397a94f9b33b2aa3dce4b771368fa04692a522bdcd28` |
| `matriz-permisos.sql` | `9723cf6daa5ce20ba14ae71fff19b6d493e2a21356cda16a6aab848fc2339b95` |
| `ensayo-076-v4.sh` | `1527e545c3e4d1ee5ac1db2d827b669f2721f4929ec2a205fcde5b48f26f6e92` |
| `076_audio_guide_selection.sql` | `4588d86b7744b6d5cba0359f31b9f53c71d5e9c9c91577376fe22cedff94c461` |
| `rollback-076.sql` | `b23aa5cce4c1fc36d44a1e45fec442de2690e64c9bb0c1c96864eb98f389d229` |
| `verify-schema.sql` (PR #38) | `ee2e4ca1a7147f9b070f7a66052f1d5eb2d7d621c7f9fc517d6a655f83447f5c` |

## 5. Estado de recursos y producción tras el ensayo
Sin contenedores del ensayo ni carpetas temporales. `supabase-db` en marcha desde 2026-10-16T16:14:30Z, 0 reinicios. `wacrm-app-1` en `wacrm-app:audio-guard-7b9208d7`, healthy, 0 reinicios. El esquema de producción sigue sin 076 (comprobado en solo lectura).

## 6. Limitaciones de la prueba aislada
1. **Sin cuentas, contactos ni usuarios reales.** Las 76 filas de productos apuntan a cuentas que no están en la copia; los controles de claves foráneas se probaron con cuentas simuladas dentro de transacciones.
2. **Sin tráfico concurrente.** La duración (0,19 s) y los bloqueos son los de una base inactiva. Bloqueos observados: ACCESS EXCLUSIVE en `audio_guide_items` y `audio_guide_requests`; SHARE ROW EXCLUSIVE en `accounts` (por la nueva clave foránea → bloquea escrituras en `accounts` mientras dura la transacción).
3. **Propietarios distintos.** En la copia todo pertenece a `supabase_admin` (en producción hay dos propietarios). Los permisos efectivos de los tres roles son idénticos (B07), no los propietarios.
4. **Sin triggers de evento de la plataforma** (`pgrst_ddl_watch`, `issue_pg_*`, que no forman parte del esquema `public`). `pgrst_ddl_watch` recarga la caché de PostgREST tras el DDL; los `issue_pg_*` solo actúan sobre extensiones. Esta diferencia se cubre con la verificación posterior en producción (V02, V05).
5. **Permisos por columna:** la matriz recoge permisos de tabla completos; 076 no añade permisos por columna ni toca la tabla donde `authenticated` no tiene UPDATE de tabla completa (permisos `ra-dDxt` en la matriz).
6. **Las pruebas funcionales se ejecutan como superusuario**: no prueban RLS ni permisos de rol; esa cobertura la dan la matriz, `verify-schema.sql` y la QA sintética (S00, V01).
7. **Un ensayo de la propia secuencia de producción** (`aplicar-076.sh`) se hizo sobre una base sintética (15/15), no sobre la copia real.
8. **Datos de solicitudes y envíos reales:** 0 y 0; el comportamiento con solicitudes reales se probó con la función antigua sobre un producto real (F01) y con solicitudes creadas en transacciones.

## 7. Riesgos residuales
| Riesgo | Mitigación |
|---|---|
| Bloqueo breve de `accounts`/`items`/`requests` con tráfico real | `lock_timeout` 3 s, reintentos (3), espera de hueco tranquilo, ventana de poco tráfico |
| Cambio de esquema o permisos entre aprobación y aplicación | pre-vuelo con huella de estructura (1320 líneas), matriz de permisos y conteos fijados |
| Copia de seguridad antigua (la última tiene 2 días) | respaldo nuevo con restauración de prueba obligatorio antes (PF10) |
| Rollback tras existir finalidades/identificadores/solicitudes | prohibido por diseño; ver el plan (§ Reversión) |
| PostgREST con caché antigua | `pgrst_ddl_watch` presente en producción; la imagen actual solo usa funciones antiguas |
| Error humano al lanzar | cada modo que escribe exige `CONFIRM_*=yes`; el pre-vuelo es de solo lectura |

## 8. Recomendación técnica
**GO condicional** para aplicar 076 en una ventana controlada, **solo** si se cumplen los criterios del plan (§ GO/NO-GO). La migración es aditiva, probada contra una copia fiel (estructura, permisos y datos), reversible mientras esté vacía, y la imagen actual no la necesita ni la ve. Aplicarla no cambia ningún comportamiento visible: su valor es desacoplar el cambio de esquema del despliegue de las fases 2–4. Recomiendo fusionar antes el PR #38 (sin CI configurado; el contenido es idéntico al ensayado) para que repositorio y base coincidan.
