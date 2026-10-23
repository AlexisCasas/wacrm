# QA posterior a la migración 076 y recuperación

Auditoría del 23-oct-2026 (06:18Z–06:26Z), **solo lectura** sobre producción, más pruebas en una base aislada cuando hacía falta escribir o simular roles. Ningún dato real fue creado ni modificado; no se envió WhatsApp, audio ni plantilla; no se ejecutó ningún nodo.

Clasificación: **PASS**, **FAIL** o **NO PROBADA** (con su motivo).

## 1. Producción (solo lectura)
| # | Prueba | Resultado | Evidencia / límite |
|---|---|---|---|
| 1 | Esquema 076: 2 tablas, 7 funciones, 8 columnas, una sola copia de cada función | PASS | estado 1/1/7/8 |
| 2 | `verify-schema.sql` completo sobre producción | PASS | `schema verification passed` (otra vez a las 06:26Z) |
| 3 | Estructura actual = la registrada al aplicar; nada retirado; nada añadido fuera de 076 | PASS | 1381 líneas; 0 retiradas; 0 fuera de 076 |
| 4 | RLS en las 2 tablas nuevas, políticas SELECT por pertenencia a la cuenta, sin FORCE | PASS | `relrowsecurity=t` |
| 5 | Permisos de las tablas nuevas: `anon` nada; `authenticated` solo SELECT; `service_role` todo | PASS | consulta por rol |
| 6 | EXECUTE de las 7 funciones: `anon` no, `authenticated` no, `service_role` sí, sin concesión a PUBLIC; todas SECURITY INVOKER con `search_path=public` | PASS | `proacl`/`aclexplode` |
| 7 | Todos los permisos previos intactos (121 objetos de referencia) | PASS | 0 líneas distintas; 9 objetos nuevos |
| 8 | Integridad: 19 restricciones y 7 índices de 076 presentes y validados; 2 triggers; 0 restricciones no validadas en las tablas de audio | PASS | catálogo |
| 9 | 76 productos y 76 audios: datos originales sin alterar | PASS | hash por tabla igual al previo |
| 10 | Tablas nuevas vacías y columnas nuevas NULL | PASS | 0/0/0/0 |
| 11 | Funciones anteriores (073–075) intactas | PASS | 0 retiradas ni cambiadas en el digest |
| 12 | Catálogo de audios y Flows | PASS | 355 Flows, 2920 nodos, 76 productos y 76 audios activos, igual que el respaldo previo |
| 13 | Compatibilidad con la imagen en producción | PASS (por análisis y 2 pruebas) | la imagen usa `select` con columnas explícitas y solo las RPC antiguas; el ensayo F01 probó `open_request` antiguo sobre un producto real; 0 errores de columnas/funciones en el log |
| 14 | Logs de la aplicación desde la aplicación (13 min) | PASS | 0 líneas de error, audio, columnas, funciones, PGRST o permisos |
| 15 | Logs de PostgreSQL desde la aplicación (13 min) | PASS | 0 líneas ERROR/FATAL |
| 16 | Solicitudes, envíos y actividad comercial antes/después | PASS | solicitudes y envíos de audio siguen en 0 (nadie los usa aún); bot enviando en ráfagas igual que antes (≈1500/h), 0 mensajes fallidos antes y después |
| 17 | Disponibilidad de la aplicación y de la API (GET sin credenciales) | PASS | `/login` 200, `/` 307, `/api/audio-guide/health` 401, `/api/flows/voice-notes` 401, 200 dentro del contenedor; sano y 0 reinicios |
| 18 | Observación de 5 minutos del script (V07) | **NO PROBADA** | el script terminó antes; sustituida por la auditoría independiente de 13 min (#14–#17), que no equivale a ella |
| 19 | Código de salida del script | **NO PROBADA** | no se registró |
| 20 | Permisos por columna | **NO PROBADA** | la matriz recoge permisos de tabla completos; 076 no añade permisos por columna |

## 2. Base aislada (roles reales con JWT, no superusuario) — `test-rls-permisos-076.sh`
| # | Prueba | Resultado |
|---|---|---|
| R01–R02 | Un miembro de la cuenta A (rol `authenticated`) ve solo las finalidades de A; el de B, solo los identificadores de B | PASS |
| R03 | Un usuario autenticado sin cuenta no ve nada | PASS |
| R04 | `anon` no puede leer las tablas nuevas | PASS |
| R05 | `authenticated` no puede insertar, modificar ni borrar finalidades/identificadores, ni clasificar audios, ni tocar solicitudes | PASS |
| R06 | `authenticated` lee solo los audios de su cuenta, con las columnas nuevas | PASS |
| R07 | `anon` y `authenticated` reciben `permission denied` en las 7 funciones (14 llamadas) | PASS |
| R08 | `service_role` ejecuta las funciones | PASS |
| R09 | Un rol sin permisos (equivale a PUBLIC) no puede ejecutar ninguna | PASS |
Limitación: base sintética (esquema de las migraciones 001–076 más los sustitutos de plataforma de `flows-safe-save/bootstrap.sql`), no la copia de producción; los eventos de plataforma de Supabase no existen allí.

## 3. Recuperación
- **Imagen:** la imagen actual (`audio-guard-7b9208d7`) no usa 076; volver a la anterior (E8, `audio-nodes-1a8f4136`) no requiere tocar la base.
- **Respaldo previo a 076:** `wacrm_pre_audios_20261023_052747.dump` (+ `.sha256`, `.restore-ok` con 8/8 criterios, y el volcado de roles). Es el único punto de restauración completo previo a la migración.
- **Configuración:** copia privada de `.env.local` y los 3 archivos de Compose en uso, con manifiesto SHA-256 (fuera del repositorio).
- **`rollback-076.sql`:** solo mientras no exista **ninguna** finalidad, identificador, audio clasificado ni solicitud selectiva. En cuanto exista alguno está **prohibido**: borraría las dos tablas nuevas, la clasificación de los audios y los datos de las solicitudes selectivas. Entonces se deja el esquema (inofensivo) y se vuelve a la imagen anterior; si hiciera falta quitarlo de todos modos, se exportan antes esas tablas y columnas, con decisión humana explícita.
- **Estado actual de esas condiciones:** todo en 0 (a las 06:26Z), de modo que el rollback sigue permitido; deja de serlo cuando se despliegue la interfaz y alguien cree una finalidad.

## 4. Reverificación posterior a la limpieza de respaldos (23-oct-2026, 06:44Z, solo lectura)
Se repitieron las comprobaciones esenciales 32 minutos después de aplicar. **Todos los resultados se mantienen:**
- Estado 1/1/7/8; `verify-schema.sql` aprobado; estructura idéntica a la registrada al aplicar (1381 líneas); permisos idénticos a los registrados tras la aplicación y sin pérdida respecto a la referencia previa; datos de productos, audios, solicitudes y envíos con los mismos hashes; tablas nuevas vacías y columnas nuevas NULL.
- Aplicación `audio-guard-7b9208d7` sana, 0 reinicios; PostgreSQL sin reinicios; 0 líneas de error de audio, columnas, funciones o permisos en la aplicación y 0 líneas ERROR/FATAL en PostgreSQL desde la aplicación; `/login` 200 y `/api/audio-guide/health` 401 sin credenciales.
- **Siguen NO PROBADAS** (sin cambio): la observación de 5 minutos del script (V07) y su código de salida (EXIT). El `run.log` sigue terminando en V06, sin resumen ni manifiesto.
- Observación comercial (sin atribuir causa): el envío del bot, que fue continuo (≈ 1300–2000 mensajes/hora) desde la tarde del 22-oct, fue descendiendo hasta casi cero a partir de las 06:10Z (bloques de 10 min: 370 → 108 → 72 → 36 → 7), con **0 mensajes fallidos**. El descenso empezó antes de aplicar la migración y es gradual, compatible con el vaciado de una cola de envío; la migración no la usa la aplicación. Conviene confirmar con el negocio que la campaña terminó.
- Nota: `aplicar-076-v2.sh preflight` ya no puede dar 10/10 (PF03 exige 076 ausente); es el comportamiento diseñado.
