# CALL-RBAC-01 — Desarrollo y despliegue controlado (InkaClick)

**Estado:** código candidato, no aplicar en producción antes de CI y QA. Baseline: `wacrm-app:global-incoming-alert-9076c1c8` y Meta `callback_permission_status=ENABLED`. Respetar los PR apilados #164 → #167 → #168 → #169.

## Implementación

La **única matriz de autorización** está en `src/lib/auth/operational-role.ts`: `account_role` = owner/admin/agent **Y** `profiles.operational_role` = logistics/supervisor. Sin bypass de owner Comercial. Para otros valores y errores se deniega.

En el navegador `useCan('use-calling')` separa Calling de `send-messages`; el perfil trae el área vigente de `profiles.operational_role`. `CallingPanel` y `GlobalIncomingCallAlert` no muestran controles/polling a Comercial. Se conserva el control de colgar si la sesión ya está activa al perder el permiso.

En el servidor `assertCallingOperator` vuelve a leer la fila de `profiles` por **account_id y user_id** recibidos de `requireRole('agent')`; se llama antes de todas las rutas GET (historial, SDP, elegibilidad, alertas) y POST (claims, señalización, permisos, salientes). La única excepción para miembros que perdieron el área es **release** si poseen el claim actual y **terminate** si se identifica al mismo iniciador/aceptante/claimant de una sesión activa de la misma cuenta. No pueden adquirir nuevos claims, aceptar ni llamar. Todos los RPC de calling deberán seguir exclusivos de `service_role`.

No cambian las configuraciones de Meta, WhatsApp webhooks, Flows, cuentas ajenas, RLS, permisos de mensajes ni migraciones.

## Gates antes de la VPS

1. PR CI SUCCESS: lint, typecheck, tests, build y contratos Docker.
2. Auditoría DB **solo lectura**: constatar que `profiles.operational_role` existe y contar membresías por área sin exponer datos individuales. No cambiar perfiles.
3. Auditar ACL reales de todas las RPC `whatsapp_call_*` (especialmente claim, SDP, signal, terminal y outbound), revisar `anon`/`authenticated` sin EXECUTE. Si hay alguna exposición, STOP y preparar correctivo dedicado con migración validada, nunca ignorar.
4. Fuente Git exacta y worktree limpio. Respaldo de base de datos con checksums y plan rollback (antes del corte).
5. Confirmar imagen actual `wacrm-app:global-incoming-alert-9076c1c8`, health, Caddy `wacrm-app-1:3000`, flags Keyler only/Flows, `ACTIVE_CALLS=0`.
6. Construir nueva imagen con mismos BUILD ARG públicos del contenedor vigente. Ejecutar pruebas focalizadas, `ops/deploy/deploy.sh <imagen>` dry-run, después `--execute`; no usar `docker compose up` directo.
7. Postdeploy: controles Caddy/readiness/no-502, imagen/revision, rollback dry-run; mantener old privado.
8. QA por dos usuarios reales distintos: Logística acepta una entrante + audio; Supervisor llama a contacto con permiso Meta vigente + audio; Comercial ve Inbox y envía mensajes pero **no** recibe alerta ni tiene botón Llamar; petición directa GET/POST Calling devuelve 403; viewer 403; usuario sin área 403. Revisar historial solo con perfiles autorizados, mensajes/Flows y aislamiento de tenants.
9. Democión durante llamada: permitir colgar la llamada ya iniciada con su actor original, **no** nuevas llamadas. Validar que no se pueda terminar la llamada de otro agente.
10. No hacer merge de PR apilados ni activar otras cuentas hasta QA y revisión de árbol de `main` y producción.

### Comandos read-only de ACL y perfiles (VPS)

```bash
docker exec -i supabase-db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT p.account_role, COALESCE(p.operational_role::text, '(sin área)') AS area, COUNT(*) AS miembros
FROM public.profiles p
JOIN public.whatsapp_config w ON w.account_id=p.account_id
WHERE w.phone_number_id='740434745820831'
GROUP BY p.account_role,p.operational_role
ORDER BY area,p.account_role;

SELECT p.proname,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'whatsapp_call_%'
ORDER BY p.proname;
ROLLBACK;
SQL
```

**No imprimir** llaves, SDP, IDs de clientes, nombres de clientes ni secretos. Si las ACL son distintas a las migraciones, no desplegar hasta conciliar.

## Estado actual del cierre previo

- Entrantes, salientes autorizadas, global alert, audio bidireccional: PASS real reportado.
- Meta callback setting ENABLED + GET de verificación + Caddy/health PASS.
- Devolución real con **contacto sin permiso anterior**: PENDING, independiente de RBAC.
