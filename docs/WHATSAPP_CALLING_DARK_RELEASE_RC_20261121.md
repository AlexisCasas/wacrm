# CALL-03 / WhatsApp Calling — Integration RC, dark deployment only

**Estado: DRAFT / NO-GO PRODUCTIVO.** La rama RC parte del HEAD de CALL-03B2.6 `17c4c86189bac64a351ebfb86b36466e0e50a418`, y agrega exclusivamente un contrato de validación estática en CI y este documento. No hay despliegue, migración ni activación Meta.

## Evidencia QA aceptada y pendiente

- Rechazo independiente en Peer + PostgreSQL: `CALL03B26_QA_REJECT=PASS`, 27 sesiones, 5 rechazadas, 0 llamadas/claims/SDP/reservas pendientes; `wacid.qa-8a8b547d-049e-4ffb-a04e-2b5811b02a9c`.
- Llamada entrante aceptada/cerrada: `CALL03B26_CONCURRENCY=PASS_SQL_ONLY`, un registro `wacid.qa-8490f9f6-b72b-4dfd-bf28-941dfda9ed6f`, 0 claims/SDP/reservas.
- Dos equipos y dos agentes: el operador reportó un solo aceptante y otro bloqueado. **Falta correlación de call ID/HTTP 200-409/micrófono y acciones Graph**; no afirmar E2E concurrencia auditado.
- CI y Migrations del HEAD del PR #148 `19b4a2cf56fe764af72cfaf26b8c7c1e76400877`: PASS, pero los últimos commits documentales de QA tienen que validarse por su propio SHA. CI y Migrations de la **rama RC** también deben pasar en el commit exacto; no heredar resultados.
- Simulación de `unknown` Graph en **QA compartida** y pruebas solapadas HTTP `accept` vs `terminate`: **PENDIENTES**. Un mock protegido con fault-injection se desarrolla exclusivamente en PR #149 sobre #141 y no debe importarse a la rama RC.
- `unknown` requiere revisión manual del resultado Meta, jamás reintento automático ni limpieza programada.
- El restore-test anterior de QA se omitió por decisión del operador. No asumir ese riesgo para producción.

## Inventario de dependencias

Cadena funcional: **#134 CALL-01 → #136 CALL-02 → #137 CALL-03A → #138 CALL-03B → #140 cliente WebRTC → #142 asociación entrantes → #143 claim antes de micrófono → #144 reserva terminal → #146 fencing signal/terminal**.

La rama de #146 ya contiene la historia de esa cadena. No se debe fusionar cada PR apilado a `main` de forma inadvertida ni duplicar cambios/migraciones. **Esta RC es un único PR Draft de revisión contra `main`**, no una autorización de merge. PR #148 contiene únicamente verificadores y evidencias QA sobre #146; PR #141 y #149 contienen el simulador Graph/peer (no integrar). PR #139 cerrado sin merge queda excluido salvo inspección explícita.

Al preparar este RC, el compare del HEAD #146 con `main` (`9178218d67d46ca2d37d50d57655d3484c8ef867`) era **divergente: 386 commits ahead y 2 behind**, con ~59 archivos afectados. Los 2 commits de `main` se refieren al workflow aislado QA (#145, #147). Antes de merge, refrescar ambas ramas, revisar compare `main...RC` y resolver divergencias en una rama de integración controlada; no forzar ni suprimir commits de producción. Verificar que el release no arrastra artefactos o configuraciones QA.

## Contrato de integración

- En CI, `bash scripts/qa/whatsapp-calling/verify-calling-dark-release.sh` exige guard server-side `WHATSAPP_CALLING_ENABLED !== 'true'`, uso de la allowlist en API, las **ocho** migraciones y ausencia de archivos de runtime del mock Graph.
- La comprobación es **estática**; no ve variables reales de la VPS ni demuestra que el tráfico Meta quede aislado. Verificar externamente que producción mantenga `WHATSAPP_CALLING_ENABLED=false` y webhook Meta `calls` OFF. `messages` debe permanecer ON.
- No asumir que la UI/Inbox no aparece solo por feature flag; revisar visualmente controles y regresiones con la bandera OFF.
- No incluir/ejecutar `MOCK_FAULT_INJECTION_ENABLED`, servicios `mock-graph`, `peer` ni `qa-call03b2` en Compose de producción.
- La imagen QA basada en `17c4c86189ba` no es artefacto productivo; crear artefacto nuevo solo de SHA de release revisado, con hash/digest/rollback documentados.
- Ocho migraciones SQL aditivas deben ser probadas contra una réplica/restauración de **producción** y aplicadas antes de arrancar código que las requiera, después de backup/restauración verificada. Las migraciones nunca se consideran autorizadas por la creación de este PR.
- No alterar los cron de WACRM existentes ni los nombres de contenedores sin auditar sus dependencias.
- Con el primer despliegue productivo mantener bandera OFF, webhook `calls` OFF y no enviar tráfico real de Calling; verificar salud, mensajes, flujos, permisos y bandeja.
- **Fase de activación de Meta y piloto Keyler independiente:** requiere autorización separada, consentimiento y pruebas de webhook firmado/latencia/audio/atribución/callback real, con rollback.

## Gates formales para reviewer

| Gate | Requisito | Estado al abrir RC |
|---|---|---|
| QA-R | Rechazo sin aceptar | PASS |
| QA-C | Concurrencia A/C HTTP/logs correlacionada | PARTIAL / pendiente |
| QA-U | Resultado incierto signal y terminal, mock fault | PENDING |
| QA-RACE | Accept/pre_accept concurrente con terminate (HTTP/Graph) | PENDING |
| QA-HIST | MD5 18 sesiones históricas después de E2E | PENDING revalidación |
| INT-01 | RC diff auditado, mock excluido, divergencia main resuelta | PENDING |
| INT-02 | CI+Migrations+static guard para SHA RC final | PENDING |
| PROD-01 | Preflight VPS de solo lectura y regresión de mensajes | PENDING |
| PROD-02 | Backup fresco y prueba restauración aislada | PENDING |
| PROD-03 | Plan de rollback, ventanas, aprobaciones humanas | PENDING |
| META-01 | Activación real expresamente aprobada | **NO AUTORIZADA** |

**Resultado:** candidato exclusivamente para revisión. Ningún merge ni despliegue ejecutado. No es GO para producción; next action: completar QA en VPS aislada y examinar PR Draft contra `main`.
