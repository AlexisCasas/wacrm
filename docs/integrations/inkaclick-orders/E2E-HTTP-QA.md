# QA HTTP extremo a extremo del receptor `wacrm-confirmed-orders` (entorno desechable)

Fecha: 2026-10-31. Receptor probado: `InkaClick-Saas@main` (`eb41e5d`). Reproducible con `e2e/run.sh` (ver abajo). No hay datos personales, nombres ni secretos: todo es sintético y los secretos se generan en cada ejecución y se descartan.

## Entorno
Red Docker propia, **sin puertos publicados**, sin volúmenes ni secretos de producción. Se elimina al terminar (`down -v`).

| Pieza | Imagen |
|---|---|
| PostgreSQL | `supabase/postgres:17.6.1.136` (réplica del esquema de `confirmed_orders`/`customers` y sus 5 disparadores, sin datos) |
| API REST | `postgrest/postgrest:v14.17` |
| Edge Runtime | `supabase/edge-runtime:v1.74.0` (ejecuta la función real, sin modificar) |
| Gateway | `kong:2.8.1` |

## Resultados
| # | Prueba | Resultado |
|---|---|---|
| H1 | POST sin token → 401 | PASS |
| H2 | POST con token incorrecto → 401 | PASS |
| H2b | Un JWT de `service_role` no sirve como secreto del receptor → 401 | PASS |
| H2c | GET sin token → 401 | PASS |
| H2d | Otra función sin JWT sigue protegida (401 `Invalid JWT`) | PASS |
| H3 | POST válido → 201 con id | PASS |
| H4 | POST repetido → 200 y mismo id | PASS |
| H5 | GET de reconciliación → mismo id; id inexistente → 404; mal formado → 400 | PASS |
| H6 | 10 payloads inválidos → 422 con código y sin crear fila; JSON inválido → 400; `Idempotency-Key` distinto del cuerpo → 400; método no permitido → 405; sin datos del cliente en errores | PASS |
| H7 | 25 envíos concurrentes con el mismo id → 1×201, 24×200, mismo id, sin 5xx, 1 fila | PASS |
| H8 | Respuesta perdida tras procesar (conexión cortada sin leer): GET → 200 y reintento → 200 con el mismo id | PASS |
| H9 | Disparadores: teléfono normalizado, cliente creado (DNI solo con 8 dígitos), `pago_restante = precio`, estado sin pagar; al registrar el pago el disparador lo marca como pagado | PASS |
| H10 | ManyChat: dos filas con el mismo `duplicate_key` se insertan igual (índice no único) y no interfieren con las de WACRM | PASS |
| H11 | `anon`/`authenticated` sin permiso sobre la función ni sobre `wacrm_order_events`; RLS activa | PASS |
| H12 | Ni el secreto ni datos del cliente aparecen en los logs de la función ni del gateway | PASS |

Totales: 4 pedidos WACRM distintos, 4 `external_order_id` distintos; eventos `created` ×4 y `replayed` ×26.

## Autenticación con `verify_jwt = false`
La función exige siempre su secreto: sin token o con uno ajeno (incluido un JWT válido de `service_role`) responde 401. El router del entorno emula `verify_jwt = false` solo para esta función y mantiene la verificación en las demás (H2d).

## Limitaciones (no se declara PASS en estas)
1. **Supabase CLI no está instalado** en el servidor; se montó el equivalente con las imágenes oficiales. No es `supabase start`.
2. **Gateway y verificación de JWT**: el entorno usa Kong y un router propio, no el gateway alojado de Supabase. Que `verify_jwt = false` de `config.toml` / `--no-verify-jwt` se aplique en el proyecto real **no está probado**: se comprueba en la fase de instalación con las pruebas H1–H2 contra la URL real.
3. **Esquema**: réplica capturada de producción en solo lectura (5 disparadores coinciden), no la base real.
4. Versión de Edge Runtime del proyecto alojado desconocida.
5. Cada repetición (`replayed`) añade una fila a `wacrm_order_events`: crecimiento acotado por los reintentos, a vigilar.

## Reproducir
```bash
INKA=/ruta/a/InkaClick-Saas ./docs/integrations/inkaclick-orders/e2e/run.sh
```
