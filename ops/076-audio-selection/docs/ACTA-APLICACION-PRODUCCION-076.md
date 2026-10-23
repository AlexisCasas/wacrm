# Acta de aplicación productiva de la migración 076 (selección de audios por producto)

**Fecha:** 23-oct-2026. **Resultado de la migración: PASS.** **Registro de la ejecución del script: INCOMPLETO** (ver §3: faltan la observación final V07, el resumen y el código de salida).

## 1. Qué se aplicó
- Migración `supabase/migrations/076_audio_guide_selection.sql` (PR #38, merge `8cc7e16b4daacf32dd9478f8223f87807e611f52`), SHA-256 `4588d86b7744b6d5cba0359f31b9f53c71d5e9c9c91577376fe22cedff94c461`. **No se modificó** el SQL ya aplicado.
- Contenido: 2 tablas nuevas vacías (finalidades e identificadores por cuenta), 8 columnas nuevas NULL (2 en los audios, 6 en las solicitudes), 1 índice único parcial, 19 restricciones, 2 políticas RLS, 2 triggers `updated_at` y 7 funciones solo para `service_role` (SECURITY INVOKER).
- Script usado: `audio-guide/produccion-076/aplicar-076-v2.sh`, SHA-256 **`0cd3f66a4681e7c1e11ef04bdafcff34203155a481ce5a89a85a23d7bb775549`** (revisión 2 del procedimiento: revalida el respaldo tras el hueco tranquilo y antes de cada intento).
- Aplicación: 06:12:47Z, un único intento, una sola transacción, **0,51 s**. Sin reintentos ni aplicaciones duplicadas (un solo `mig076-attempt1`, con salida y errores vacíos).

## 2. Evidencia de la ejecución auténtica
Carpeta `evidence-076-20261023T060333Z` (modo 700). Las otras dos carpetas `evidence-076-…T054012Z` y `…T060330Z` son **pre-vuelos de solo lectura**, no aplicaciones.

| Elemento | Resultado en el registro |
|---|---|
| PF01–PF10 (pre-vuelo dentro de `apply`) | PASS 10/10 |
| Hueco tranquilo (60 s sin mensajes del bot ni ejecuciones de Flows) | QUIET GAP OK a las 06:12:47Z |
| BK1 (respaldo revalidado tras el hueco) | PASS |
| BK-attempt1 (respaldo revalidado antes del intento) | PASS (respaldo de 2674 s; máximo 5400 s) |
| A01 (aplicación transaccional) | PASS en 0,51 s |
| V01 estado 1/1/7/8 (tablas/tablas/funciones/columnas) | PASS |
| V02 `verify-schema.sql` completo sobre producción | PASS |
| V03 nada eliminado ni cambiado; solo 61 líneas de estructura añadidas, todas de 076 | PASS |
| V04 hash de cada columna original de productos, audios, solicitudes y envíos | PASS (idéntico) |
| V05 permisos previos intactos (9 objetos nuevos) | PASS |
| V06 tablas nuevas vacías y columnas nuevas NULL | PASS |
| **V07 observación de 5 minutos** | **NO REGISTRADA** |
| Resumen final, `MANIFEST.sha256` y código de salida | **NO REGISTRADOS** |

SHA-256 de los artefactos de la carpeta (el `run.log` dejó de escribirse a las 06:12:49Z):
- `run.log` `5dd86a8746df19c4bfdcc677bf3a915932dec69db68c0ca19a1885899473b174`
- `pre.struct` `7ae2cff2db9bf1cc6b1846c22c46f9ac6cb5043dfcb5005771afe094b7e99aab` · `post.struct` `677877b28b10d80ec60255ecb3c8853eb597ea7ce8cbc854cbce51372aab746e`
- `pre.data` = `post.data` `afbd13067f4af2bc3b87a09144697d316e7de1e2afe37e9699414722ebe522ba`
- `pre.matrix` `43d20a85435f9f698e68397a94f9b33b2aa3dce4b771368fa04692a522bdcd28` · `post.matrix` `0f796b7da624e26f60d331d974fd1e8268d88bc7c21a0108a1a7868659e19021`
- `added` `f6bac48d3cacccd83b1f0e92820fccbde594d1b02e01ed8f132e9374b4ffaa32`; `removed`, `unexpected`, `mig076-attempt1.out` y `.err` están vacíos (`e3b0c442…b855`).

## 3. Por qué el registro está incompleto (hecho, no hipótesis)
El `run.log` termina en V06 a las 06:12:49Z. En ese script el resultado V07 se escribe solo al final de los 5 minutos de observación, y el resumen y el manifiesto después. No hay proceso `aplicar-076` ni sesión `mig076` activos: el proceso terminó antes de completar la observación. **La causa no está registrada** (probablemente se cerró la sesión de terminal; no se puede afirmar). El código de salida **no se registró y no es recuperable: no está verificado.** No se repitió `apply`.

## 4. Verificación independiente posterior (solo lectura)
Como sustituto de V07 y del resumen se auditó producción por separado (detalle en `QA-POSTERIOR-076-Y-RECUPERACION.md`): estado 1/1/7/8 y una sola copia de cada función, `verify-schema.sql` aprobado de nuevo, estructura idéntica a la registrada tras la aplicación (1381 líneas; 0 retiradas; 0 fuera de 076), permisos previos intactos, datos originales idénticos, aplicación `wacrm-app:audio-guard-7b9208d7` sana y sin reinicios, 0 errores de la aplicación o de PostgreSQL relacionados con audio, columnas, funciones o permisos durante los 13 minutos siguientes, y bot enviando con normalidad (144 mensajes, 0 fallidos). Esto cubre el objetivo de V07, **pero no equivale** a la observación de 5 minutos del script.

## 5. Estado funcional
El SQL de 076 está aplicado. **Las funciones de interfaz, de API, del nodo y del editor aún no están desplegadas**: la imagen en producción sigue siendo `audio-guard-7b9208d7`, que no usa nada de 076. No hay finalidades, identificadores ni solicitudes selectivas (todo en 0), de modo que `rollback-076.sql` seguiría siendo utilizable mientras eso no cambie.

## 6. Pendientes derivados
1. Si se vuelve a usar el script, escribir cada resultado V07 con su hora y registrar el código de salida en el propio log.
2. Fases siguientes (API, contrato del nodo y ejecutor, editor) requieren autorización propia; desplegarlas hará que dejen de valer las condiciones de rollback de §5.
