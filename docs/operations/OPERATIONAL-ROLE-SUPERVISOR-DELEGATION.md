# Delegación de áreas operativas al Supervisor (PR-01 ajuste de permisos)

Estado: **preparado, sin commit / push / PR / deploy**. Probado solo contra Supabase LOCAL (`127.0.0.1:55322`). Producción no fue tocada.

Feature flag involucrado: `order_integration_settings.logistics_mvp_enabled` (por cuenta, `FALSE` por defecto; esta migration nunca lo activa).
`confirm_enabled`, `multiproduct_enabled` y la integración externa (`enabled`) no intervienen: no se envía nada a InkaClick.

## Reglas finales (la RPC es la única autoridad)

| Quien llama | Puede asignar | No puede |
|---|---|---|
| `owner` / `admin` (account_role) | `commercial`, `logistics`, `supervisor`, NULL — a cualquier miembro de su cuenta (supervisores incluidos) | — |
| `owner`/`admin` que además es supervisor | igual que arriba (conserva todo el poder) | — |
| Supervisor operativo que NO es owner/admin (p. ej. `agent`) | `commercial`, `logistics`, NULL — solo a miembros que **no** son owner/admin y **no** son supervisor | asignar `supervisor`; tocar a un owner/admin (con o sin área); modificar/quitar a otro supervisor; modificarse a sí mismo (autoelevarse o auto-degradarse); tocar `account_role`/`account_id`; operar sobre otra cuenta |
| `agent` / `viewer` sin área supervisor | nada | todo |

Siempre: sesión (`auth.uid()`), misma cuenta, `logistics_mvp_enabled = TRUE`, y solo se escribe `profiles.operational_role`.
Un supervisor no puede auto-degradarse a propósito (evita quedarse sin acceso por error); lo puede hacer un owner/admin.
El `UPDATE` directo desde el navegador de `operational_role` / `account_role` / `account_id` sigue bloqueado por el trigger `enforce_profile_privilege_columns` (sin cambios).

Concurrencia: la RPC bloquea las filas de `profiles` del llamador y del destino (`FOR UPDATE`, orden `user_id` ASC → sin deadlock) y lee los hechos de autorización **después** del bloqueo. Un cambio concurrente (degradación del supervisor, cambio de cuenta o de área del destino) no puede colarse entre la comprobación y el `UPDATE`.

## Cambios

- **Migration nueva** `supabase/migrations/20261204000000_operational_role_supervisor_delegation.sql`: solo `CREATE OR REPLACE FUNCTION public.set_member_operational_role(uuid, operational_role_enum)` + `OWNER TO postgres` + `REVOKE … FROM PUBLIC, anon` + `GRANT EXECUTE … TO authenticated`. No toca tablas, columnas, tipos, triggers, políticas ni datos. La migration `20261121000000` NO se modificó.
- **API** `PATCH /api/account/members/[userId]/operational-role`: ya no exige `requireRole("admin")` (un supervisor puede ser `agent`); exige sesión, valida UUID + `operational_role ∈ {commercial, logistics, supervisor, null}`, llama a la RPC y traduce `42501→403`, `22023→400`, resto→500 genérico. No lee `account_id` ni roles del navegador.
- **UI** `src/components/settings/members-tab.tsx` + helper `assignableOperationalRoles` (`src/lib/auth/operational-role.ts`): owner/admin ven Sin asignar / Comercial / Logística / Supervisor; un supervisor no-admin ve Sin asignar / Comercial / Logística y un supervisor existente aparece solo lectura; agent/viewer solo ven el área. El dropdown técnico owner/admin/agent/viewer no cambió.
- **Tests**: `operational-role.test.ts`, `migration-operational-role-delegation.test.ts`, `operational-role/route.test.ts` (actualizado) y el script SQL transaccional `supabase/ci/operational-role-delegation-test.sql` (45 comprobaciones contra la BD real, termina en `ROLLBACK`).

## Orden de aplicación en el futuro deploy

1. Backup de BD (o al menos de `pg_get_functiondef` actual de la RPC).
2. Aplicar la migration `20261126000000` **antes** de la imagen de la app (se aplica sola con el flujo normal de migrations; solo reemplaza una función).
3. Ejecutar `supabase/ci/operational-role-delegation-test.sql` en un entorno de pruebas / staging (es transaccional y hace ROLLBACK; no lo ejecutes en producción sin autorización).
4. Desplegar la imagen de la app.

## Compatibilidad hacia atrás

- Migration primero + app anterior: la app anterior solo llama a la RPC desde una ruta `admin+`; para owner/admin el resultado es idéntico al anterior. Sin cambios de firma.
- App nueva + migration antigua (no recomendado): un supervisor vería el selector pero la RPC antigua lo rechazaría con 403 (falla cerrada, sin escalada).
- Cuentas con `logistics_mvp_enabled = FALSE`: la UI no muestra nada y la RPC responde `operational_roles_disabled` como antes.

## Rollback propuesto

Volver a la función original (solo admin/owner). No hay datos que revertir; las áreas ya asignadas se conservan.

```sql
CREATE OR REPLACE FUNCTION public.set_member_operational_role(
  p_user_id UUID,
  p_operational_role public.operational_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_enabled BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(s.logistics_mvp_enabled, FALSE) INTO v_enabled FROM order_integration_settings s WHERE s.account_id = v_caller_account_id;
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'operational_roles_disabled' USING ERRCODE = '42501';
  END IF;
  UPDATE profiles SET operational_role = p_operational_role WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;
ALTER FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) TO authenticated;
```

Si se hace rollback de la migration, hacer también rollback de la app (la UI de supervisor dejaría de funcionar, pero fallaría cerrada con 403). Para apagar la función por cuenta sin rollback: `UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>'` (con autorización).

## Smoke tests posteriores al deploy (cuenta con el flag activo)

1. `SELECT prosecdef, pg_get_userbyid(proowner), proconfig FROM pg_proc WHERE oid = 'public.set_member_operational_role(uuid, public.operational_role_enum)'::regprocedure;` → `true | postgres | {search_path=public}`; `has_function_privilege('anon', …, 'EXECUTE')` = false.
2. Owner → asigna Comercial, Logística, Supervisor y Sin asignar a un miembro (Ajustes → Miembros).
3. Con un usuario `agent` + área Supervisor: puede cambiar Comercial ↔ Logística y Sin asignar; no ve la opción Supervisor; un supervisor existente aparece solo lectura; un intento directo a la API de asignar `supervisor` responde 403.
4. Un `agent` sin área supervisor ve el área en solo lectura; la API responde 403.
5. Cuenta con el flag apagado: la pestaña Miembros no muestra áreas; la API responde 403 `operational_roles_disabled`.
6. Comprobar que `account_role` / `account_id` no cambian tras las operaciones y que ningún pedido se envía a InkaClick (no hay cambios en pedidos).
