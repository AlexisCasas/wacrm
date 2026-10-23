# Nota de limpieza de respaldos antiguos (23-oct-2026)

Tras cerrar la migración 076 se retiraron, **con autorización expresa y ejecutados manualmente por el operador**, únicamente los respaldos de prueba que ya estaban sustituidos. No se tocó ningún otro archivo, producción, la base de datos ni la configuración.

## Qué se eliminó (11 archivos, ≈ 409 MB)
Tres respaldos de prueba de la preparación de la ventana de audios, con sus archivos de compañía (`.sha256`, `.restore-ok` cuando existía, y el volcado de roles):
- `wacrm_pre_audios_20261020_131042` (sin `.restore-ok`)
- `wacrm_pre_audios_20261020_131333`
- `wacrm_pre_audios_20261021_060138`

Motivo: eran ensayos previos, sustituidos por el respaldo de la ventana del 21-oct y por el de la migración 076. Ningún script, plan ni documento los referenciaba (se comprobó antes). El borrado usó una lista explícita de rutas (sin comodines) y se negaba a continuar si alguno de los protegidos aparecía en ella.

## Qué se conservó (protegido) y verificación posterior
| Respaldo | Función | Verificación independiente (23-oct, 06:44Z) |
|---|---|---|
| `wacrm_pre_audios_20261023_052747` (+ `.sha256`, `.restore-ok` 8/8, roles) | respaldo completo previo a la migración 076 | los 4 archivos presentes; `sha256sum -c` OK |
| `wacrm_pre_audios_20261021_063518` (+ `.sha256`, `.restore-ok`, roles) | único punto previo al esquema de audios (073–075) | los 4 archivos presentes; `sha256sum -c` OK |

Siguen presentes, además: la copia de configuración previa a 076, la evidencia de la aplicación y de los pre-vuelos, y la imagen de rollback. Quedan 2 volcados `wacrm_pre_audios_*` en el directorio. Espacio libre tras la limpieza: 98 GB (50 % de uso).

## Pendiente de decisión (no ejecutado)
Archivar fuera del VPS ≈ 1,2 GB de volcados históricos; `node_modules` y cachés regenerables (≈ 14 GB); los 21 volúmenes Docker anónimos (PostgreSQL 15 y Redis, ajenos a WACRM) **no se consideran prescindibles** hasta identificar a su propietario.

## Aviso sobre el pre-vuelo
`aplicar-076-v2.sh preflight` es de un solo uso por diseño: con 076 ya aplicada falla en **PF03** («076 debe estar completamente ausente»). Eso es el comportamiento correcto, no una regresión. Para comprobar el estado posterior se usan `verify` y el QA de `QA-POSTERIOR-076-Y-RECUPERACION.md`.
