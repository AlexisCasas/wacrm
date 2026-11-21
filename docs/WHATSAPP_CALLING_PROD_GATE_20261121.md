# WACRM Calling — Gate de transición QA → producción (21-nov-2026)

**Decisión:** `NO-GO_ACTIVACION_REAL`. Avanzar con preparación de release; **no** interpretar QA sintética ni CI verde como autorización para habilitar llamadas reales o desplegar la cadena completa.

## Evidencias constatadas

| Control | Resultado | Alcance real |
|---|---|---|
| Rechazo previo a contestar | PASS_SQL + observación manual | `wacid.qa-8a8b547d-049e-4ffb-a04e-2b5811b02a9c`; 27 sesiones/5 rechazadas, 0 activas/claims/SDP/reservas/unknown |
| Una llamada aceptada y terminada | PASS_SQL_ONLY | `wacid.qa-8490f9f6-b72b-4dfd-bf28-941dfda9ed6f`; matched=1, valid_winner=1, claims=0, sdp=0, unsettled=0 |
| Dos equipos / dos agentes | PASS_UI_REPORTED (operador) | Un equipo aceptó; al otro no se le permitió. No se han adjuntado aún trazas sanitizadas de un 200/409, de permiso de micrófono del perdedor ni del mock Graph para **esa misma** llamada |
| CI y Migrations PR #148, HEAD `19b4a2cf56fe764af72cfaf26b8c7c1e76400877` | PASS | Flujos `CI` y `Migrations` completados correctamente |
| Meta Graph real | NO_PROBADO | El webhook real `calls` permanece desactivado; el QA utiliza mock |
| Timeout Meta `unknown`, conciliación sin reenvío | PENDIENTE QA E2E | Unit tests/SQL existen, pero no se ha probado el fault injection de Graph mock compartido |
| Carrera en vuelo de `accept` vs `terminate` en Firefox/Peer QA | PENDIENTE | CI con dos sesiones PostgreSQL no sustituye prueba E2E de dos operaciones HTTP superpuestas |
| Dos pestañas del mismo agente | RIESGO RESIDUAL | Claim sin token de operación por pestaña |
| Restaurabilidad del dump QA | EXCEPCIÓN DOCUMENTADA | Restore-test QA fue omitido deliberadamente; no trasladar esta excepción a producción |
| Preparación de producción/backup/rollback | NO_VERIFICADA | Sin preflight de VPS productiva ni respaldo/restauración productiva en esta ronda |

La evidencia manual proviene del operador. No se ha accedido de forma independiente a la VPS ni a las capturas del navegador. El control PostgreSQL anterior no demuestra por sí solo que corresponda al intento simultáneo con dos agentes.

## Estado GitHub y dependencia de integración

La rama `main` observada está en `9178218d67d46ca2d37d50d57655d3484c8ef867`: integró **solo** la infraestructura QA (#145/#147), no la funcionalidad Calling. PRs sin fusionar que deben tratarse como cadena y revisar en orden: **#134 → #136 → #137 → #138 → #140 → #142 → #143 → #144 → #146**. PR #148 tiene verificadores y documentación QA; no es un release de la aplicación. PR #141 es exclusivamente el simulador Graph/WebRTC: **excluir del release de producción**. PR #139 está cerrado y no fusionado; no introducirlo incidentalmente.

No fusionar un PR apilado a `main` como atajo, ni ejecutar migraciones separadas de la versión de app que las requiere.

## Gates obligatorios antes de cualquier publicación productiva

1. **G1: QA E2E completo.** Asociar identificador nuevo de llamada con las dos sesiones de agente; observar claim 200/409 y 0 permisos de micrófono/0 pre_accept/accept en el perdedor, solo una acción externa mock. Prueba deliberadamente solapada `signal_begin` vs `terminal_reserve` a nivel HTTP, no solo SQL. Inyección mock `unknown` para signal y terminal con conciliación segura. Si alguna queda `unknown`, dejar incidencia abierta, no limpiar ni repetir a ciegas.
2. **G2: Auditoría de release.** Revisar diffs/rutas/migraciones/ACL, dependencias y gates de cada PR de la cadena; confirmar que mock #141, fixtures/credenciales QA y endpoints de pruebas no entran en el binario productivo. Evaluar límite de piloto y riesgo dos pestañas; evitar afirmación de disponibilidad general.
3. **G3: Preflight productivo de solo lectura.** Verificar imagen/digest/health actuales, DB y esquema exactos, recursos Docker, cron/colas, protección de webhooks existentes y configuración de feature flag con `WHATSAPP_CALLING_ENABLED=false`. Confirmar `calls` desactivado en Meta; `messages` debe seguir funcionando. No imprimir secretos, SDP ni datos personales.
4. **G4: Backup/restore + rollback.** Respaldo fresco DB y configuración/imágenes con checksums; ensayar restauración aislada de producción, verificar RPO/RTO acordado y rollback del contenedor, las RPC y banderas. No revertir a ciegas migraciones aditivas ni perder eventos del inbox.
5. **G5: Integración controlada.** Preparar SHA de release único derivado de `main` tras integrar la cadena en orden, exigir CI/Migrations de ese SHA exacto; no tomar como artefacto productivo la imagen QA `17c4c861...`. Gate de aprobación humana distinto para merge, migraciones y Docker deploy.
6. **G6: Publicación apagada (dark).** Únicamente tras G1-G5 PASS y autorización expresa, aplicar esquema y publicar backend/UI con feature flag Calling **OFF**, webhook Meta `calls` **OFF**. Smoke y regresión de mensajería, flujos, permisos y colas, comparación de digest/health, vigilancia de logs y rollback preparado. Si degrada mensajes, detener/rollback.
7. **G7: Activación piloto real, separada.** Solo con autorización posterior y soporte de conciliación: habilitar el número/cliente exactos, configurar webhook `calls` en Meta, realizar casos entrantes/salientes reales con consentimiento y observabilidad, audio bidireccional, eventos firmados, timing, rechazo, permisos, desconexión, aislamiento y recuperación; retroceder feature flag ante incidentes. No ampliar usuarios/tenants automáticamente.

## Decisión y responsabilidades

- **Autorizable hoy:** documentar QA y preparar G1-G4 sin escritura en producción.
- **No autorizable aún:** merge masivo de PRs apilados, migraciones en productivo, Docker deploy, habilitar Meta `calls`, abrir el piloto a clientes.
- **Responsable del despliegue en VPS:** operador humano; el asistente puede revisar GitHub y preparar plan/artefactos pero no infiere ejecución en servidor.
- **Criterio de pase:** cada gate con evidencia vinculada, SHA/fecha/alcance, operador y resultado PASS explícito. Evitar un único indicador `GO` por el solo éxito de la UI.

**Estado de cierre:** `CALL03B26_QA_PARTIAL`; `PROD_RELEASE_GATE=NO_GO`; próximo incremento: completar QA de concurrencia instrumentada/unknown y preparar integración gradual a `main` con bandera apagada.
