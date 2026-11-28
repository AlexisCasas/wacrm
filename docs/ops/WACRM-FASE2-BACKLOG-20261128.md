# WACRM — Backlog Fase 2

**Fecha de corte:** 2026-11-28  
**Base productiva al documentar:** `6a1ba63366e1c88156441c96db74c6144594e77c`  
**Propósito:** mantener una fuente única de seguimiento de los 13 requerimientos de Fase 2 y registrar el orden acordado de trabajo.

## Estado general

- Hechos: **6/13**
- Parciales: **6/13**
- Pendientes: **1/13**

> Estos estados reflejan el control funcional declarado del entregable. No sustituyen validación técnica, QA ni evidencia de producción.

## Requerimientos

| ID | Requerimiento | Estado |
|---|---|---|
| 01 | Estados logísticos | Parcial |
| 02 | Dos plantillas WhatsApp | Pendiente |
| 03 | Validación del voucher Shalom | Parcial |
| 04 | Panel de edición junto al chat | Hecho |
| 05 | Simplificación de campos | Hecho |
| 06 | Adelantos y saldo automático | Hecho |
| 07 | Accesorios y comisiones | Parcial |
| 08 | Filtros para cobranza | Hecho |
| 09 | Notificaciones Shalom | Parcial |
| 10 | Eliminar campos innecesarios | Hecho |
| 11 | Fotografías y evidencias | Parcial |
| 12 | Orden de mensajes | Hecho |
| 13 | Carga progresiva de pedidos | Parcial |

## Orden acordado para continuar

### Próximo
**02 — Dos plantillas WhatsApp**

Pendiente de definir/validar las dos plantillas, variables, idioma, disparadores y alcance de uso.

### Cerrado recientemente
**08 — Filtros para cobranza**

Desplegado en producción con commit `0c4e88bb0d52eac69a944a38c3d662f97d2425c4` e imagen `wacrm-app:cobranza-filters-0c4e88bb`.

Incluye:
- Todos
- Con saldo
- Sin pagar
- Pago parcial
- Pagado

Deploy validado con health/readiness/Caddy/crons/webhooks sin observaciones.

Confirmar las dos plantillas, variables, idioma, disparadores, roles autorizados y necesidad de aprobación en Meta antes de desarrollo/despliegue.

## Parciales a cerrar después

Orden tentativo:

1. 03 — Validación del voucher Shalom
2. 09 — Notificaciones Shalom
3. 11 — Fotografías y evidencias
4. 13 — Carga progresiva de pedidos
5. 07 — Accesorios y comisiones
6. 01 — Estados logísticos

El orden puede cambiar por dependencias o feedback operativo.

## Reglas de trabajo

- Partir siempre de la versión productiva vigente, no de `main` si está desalineado.
- Auditar antes de modificar.
- Mantener cambios acotados por requerimiento.
- Añadir tests permanentes para cada corrección.
- No mezclar cambios de DB, infraestructura o integraciones si no son necesarios para el requerimiento.
- Validar candidate, build, dry-run y rollback antes de cualquier deploy.
- Actualizar este documento cuando cambie el estado de un requerimiento.

## Siguiente acción

Iniciar definición y auditoría de **08 — Filtros para cobranza**.

Documentar:

- objetivo operativo del filtro;
- campos disponibles para cobranza;
- criterios y combinaciones necesarias;
- alcance por cuenta/rol;
- comportamiento actual;
- propuesta mínima antes de implementar.

## Decisión registrada

**12 — Orden de mensajes** se marca como **Hecho** por decisión del producto. No se abrirá un nuevo desarrollo para este punto salvo que aparezca evidencia funcional nueva.


## Producción — Cobranza

- Commit: `0c4e88bb0d52eac69a944a38c3d662f97d2425c4`
- Imagen: `wacrm-app:cobranza-filters-0c4e88bb`
- Estado: DEPLOY PASS
- Cutover: 2026-11-28 16:45 UTC
- Reinicios: 0
- Caddy: PASS
- 502 post-cutover: 0
- Crons: 0 respuestas no-200
- Webhooks: 959 procesados, 0 atascados
- Migrations: ninguna
- QA visual autenticado: pendiente por falta de sesión segura; lógica cubierta por tests automatizados.

Limitación conocida: solo los pedidos con fila en `order_financials` participan en los filtros financieros; pedidos históricos previos a `balance_trusted_since` aparecen solo en "Todos".
