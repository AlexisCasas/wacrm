# Migración 076 — selección de audios por producto: procedimiento y pruebas

Material operativo del cierre técnico de la migración `supabase/migrations/076_audio_guide_selection.sql` (**ya aplicada en producción el 23-oct-2026**; el SQL no se modifica).
**Las funciones de interfaz, API, nodo y editor todavía no están desplegadas.**

- `docs/` — actas (ensayo V4, aplicación productiva), QA posterior y recuperación, plan operativo (revisión 2).
- `audio-guide/produccion-076/` — `aplicar-076-v2.sh` (SHA-256 `0cd3f66a4681e7c1e11ef04bdafcff34203155a481ce5a89a85a23d7bb775549`), consultas de huella y pruebas aisladas (`test-*.sh`, base sintética desechable sin red).
- `audio-guide/rollback-076.sql` — se niega a ejecutarse si existe algún dato nuevo. `audio-guide/matriz-permisos.sql` — consulta de solo lectura de permisos.
- `flows-safe-save/bootstrap.sql` — sustitutos de la plataforma para las bases sintéticas.

No contiene respaldos, volcados, credenciales ni datos de clientes. Las pruebas (`bash test-*.sh`) necesitan Docker y la imagen `supabase/postgres:17.6.1.136` local; `MIG076_DIR` apunta a `supabase/migrations`.
