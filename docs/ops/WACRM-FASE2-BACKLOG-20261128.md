# WACRM — Backlog Fase 2

**Fecha de corte:** 2026-11-28  
**Base productiva al documentar:** `6a1ba63366e1c88156441c96db74c6144594e77c`  
**Propósito:** mantener una fuente única de seguimiento de los 13 requerimientos de Fase 2 y registrar el orden acordado de trabajo.

## Estado general

- Hechos: **4/13**
- Parciales: **6/13**
- Pendientes: **3/13**

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
| 08 | Filtros para cobranza | Pendiente |
| 09 | Notificaciones Shalom | Parcial |
| 10 | Eliminar campos innecesarios | Hecho |
| 11 | Fotografías y evidencias | Parcial |
| 12 | Orden de mensajes | Pendiente |
| 13 | Carga progresiva de pedidos | Parcial |

## Orden acordado para continuar

### Próximo
**12 — Orden de mensajes**

Motivo: requerimiento pendiente y acotado al Inbox/UI, con menor dependencia externa que las plantillas WhatsApp o integraciones Shalom. Antes de modificar código se debe auditar el orden actual, reglas de ordenación, realtime, paginación/histórico y comportamiento con mensajes entrantes/salientes.

### Después
**08 — Filtros para cobranza**

Definir criterios exactos de cobranza, campos, combinaciones y alcance por rol/cuenta antes de implementar.

### Luego
**02 — Dos plantillas WhatsApp**

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

Iniciar auditoría de **12 — Orden de mensajes** y documentar:

- orden actual de carga/render;
- criterio por `created_at` / `id`;
- comportamiento realtime;
- mensajes entrantes vs salientes;
- carga inicial e histórico;
- duplicados o reordenamientos;
- efecto de paginación/resync;
- propuesta mínima antes de implementar.
